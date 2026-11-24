import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, parseConfig } from "../src/config";
import type { Config, ConfigIo, OidcUserAuth } from "../src/config";
import { applyLocal, loadConfigFile, resolveConfigPath } from "../src/configfile";
import { defined } from "./support";

const oa = (config: Config) => config.userAuth as OidcUserAuth;
const io: ConfigIo = { readFile: () => "x".repeat(40) };

const base = () => ({
  public_url: "https://rc.example.com",
  user_auth: {
    mode: "oidc",
    session_secret_file: "session.secret",
    oidc: { issuer: "https://auth.example.com/application/o/rc/", client_id: "id", client_secret_file: "oidc.secret" },
  },
});

const withOidc = (record: Record<string, unknown>) => {
  const harness = base();
  return { ...harness, user_auth: { ...harness.user_auth, oidc: { ...harness.user_auth.oidc, ...record } } };
};

const problems = (raw: unknown): string => {
  try {
    parseConfig(raw, io);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }

  throw new Error("no throw");
};

describe("parseConfig", () => {
  test("defaults", () => {
    const config = parseConfig(base(), io);
    expect(config.mode).toBe("hub");
    expect(config.name).toBe(os.hostname());
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.scope).toBe("system");
    expect(config.unitDir).toBe("/etc/systemd/system");
    expect(config.claudeRcArgs).toEqual(["--spawn", "same-dir"]);
    expect(config.claudeBin).toBe("/root/.local/bin/claude");
    expect(config.roots).toEqual(["/root"]);
    expect(config.serviceUser).toBe("root");
    expect(config.serviceHome).toBe("/root");
    expect(config.namePrefix).toBe("");
    expect(config.sshAuthSock).toBeUndefined();
    expect(oa(config).oidc.allowInsecure).toBe(false);
    expect(oa(config).oidc.clientSecret).toHaveLength(40);
  });

  test("[instance] keys map to fields; user scope defaults unit dir; home defaults to /home/<user>", () => {
    const config = parseConfig(
      {
        ...base(),
        name: "box",
        port: 9000,
        host: "127.0.0.1",
        instance: {
          roots: ["/a", "/b"],
          scope: "user",
          service_user: "bob",
          claude_bin: "/opt/claude",
          claude_rc_args: ["--x"],
          name_prefix: "p-",
          ssh_auth_sock: "/s",
          service_path: "/bin",
        },
      },
      io,
    );
    expect(config).toMatchObject({
      name: "box",
      port: 9000,
      host: "127.0.0.1",
      roots: ["/a", "/b"],
      scope: "user",
      serviceUser: "bob",
      serviceHome: "/home/bob",
      unitDir: "/home/bob/.config/systemd/user",
      claudeBin: "/opt/claude",
      claudeRcArgs: ["--x"],
      namePrefix: "p-",
      sshAuthSock: "/s",
      servicePath: "/bin",
    });
  });

  test("instance.install_skill is on by default, can be turned off, and must be a boolean", () => {
    expect(parseConfig(base(), io).installSkill).toBe(true);
    expect(parseConfig({ ...base(), instance: { install_skill: false } }, io).installSkill).toBe(false);
    expect(parseConfig({ ...base(), instance: { install_skill: true } }, io).installSkill).toBe(true);
    expect(problems({ ...base(), instance: { install_skill: "no" } })).toContain(
      "instance.install_skill must be true or false",
    );
  });

  test("unknown keys are errors naming the dotted path", () => {
    expect(problems({ ...base(), instance: { rootz: ["/a"] } })).toContain("instance.rootz");
    expect(problems({ ...base(), trust_proxy: true })).toContain("trust_proxy");
    expect(problems(withOidc({ client_secret: "inline" }))).toContain("user_auth.oidc.client_secret");
  });

  test("missing required keys are all named in one error", () => {
    const item = problems({});
    expect(item).toContain("public_url");
    expect(item).toContain("user_auth");
    const count = problems({ public_url: "https://x", user_auth: { mode: "oidc", oidc: {} } });
    for (const key of [
      "user_auth.oidc.issuer",
      "user_auth.oidc.client_id",
      "user_auth.oidc.client_secret_file",
      "user_auth.session_secret_file",
    ])
      expect(count).toContain(key);
  });

  test("user_auth.mode is required and has no unauthenticated value", () => {
    expect(problems({ public_url: "https://x", user_auth: {} })).toContain("user_auth.mode");
    expect(problems({ public_url: "https://x", user_auth: { mode: "none" } })).toContain("user_auth.mode");
  });

  test("allowed_users: array of strings; empty array rejected naming the key", () => {
    const harness = base();
    expect(
      oa(parseConfig({ ...harness, user_auth: { ...harness.user_auth, allowed_users: ["kir"] } }, io)).allowedUsers,
    ).toEqual(["kir"]);
    expect(problems({ ...harness, user_auth: { ...harness.user_auth, allowed_users: [] } })).toContain(
      "user_auth.allowed_users",
    );
    expect(oa(parseConfig(harness, io)).allowedUsers).toBeUndefined();
  });

  test("role keys have defaults", () => {
    const oidcUserAuth = oa(parseConfig(base(), io));
    expect(oidcUserAuth.roles).toEqual({ claim: "clauderc_role", scope: "clauderc", defaultRole: "read", map: {} });
    expect(oidcUserAuth.sessionTtlHours).toBe(12);
  });

  test("role keys parse", () => {
    const harness = base();
    const oidcUserAuth = oa(
      parseConfig(
        {
          ...harness,
          user_auth: {
            ...harness.user_auth,
            default_role: "admin",
            role_claim: "groups",
            role_scope: "",
            session_ttl_hours: 3,
            role_map: { "clauderc-admins": "admin", off: "none" },
          },
        },
        io,
      ),
    );
    expect(oidcUserAuth.roles).toEqual({
      claim: "groups",
      scope: undefined,
      defaultRole: "admin",
      map: { "clauderc-admins": "admin", off: "none" },
    });
    expect(oidcUserAuth.sessionTtlHours).toBe(3);
  });

  test("bad role keys are errors naming the key", () => {
    const harness = base();
    const ua = (record: Record<string, unknown>) => ({ ...harness, user_auth: { ...harness.user_auth, ...record } });
    expect(problems(ua({ default_role: "none" }))).toContain("user_auth.default_role");
    expect(problems(ua({ default_role: "root" }))).toContain("user_auth.default_role");
    expect(problems(ua({ role_map: { guest: "root" } }))).toContain("user_auth.role_map.guest");
    expect(problems(ua({ session_ttl_hours: 0 }))).toContain("user_auth.session_ttl_hours");
    expect(problems(ua({ session_ttl_hours: 1.5 }))).toContain("user_auth.session_ttl_hours");
    expect(problems(ua({ session_ttl_hours: "12" }))).toContain("user_auth.session_ttl_hours");
    expect(problems(ua({ role_scope: 5 }))).toContain("user_auth.role_scope");
  });

  test("short session secret", () => {
    const short: ConfigIo = { readFile: (file) => (file.includes("session") ? "short" : "x".repeat(40)) };
    expect(() => parseConfig(base(), short)).toThrow(/session_secret_file.*32/);
  });

  test("OIDC issuer transport", () => {
    expect(problems(withOidc({ issuer: "http://auth.example.com" }))).toMatch(
      /user_auth\.oidc\.issuer must be https.*allow_insecure/,
    );
    expect(problems(withOidc({ issuer: "ftp://auth.example.com" }))).toContain("issuer");
    for (const item of ["http://localhost:9000", "http://127.0.0.1:9000/x", "http://[::1]:9000"])
      expect(oa(parseConfig(withOidc({ issuer: item }), io)).oidc.issuer).toBe(item);
    const config = parseConfig(withOidc({ issuer: "http://auth.example.com", allow_insecure: true }), io);
    expect(oa(config).oidc.allowInsecure).toBe(true);
    expect(problems(withOidc({ issuer: "http://localhost.evil.com" }))).toContain("issuer");
  });

  test("roots and claude_bin must be absolute; claude_rc_args an array of strings", () => {
    expect(problems({ ...base(), instance: { roots: ["/a", "rel/path"] } })).toContain("rel/path");
    expect(problems({ ...base(), instance: { claude_bin: "claude" } })).toContain("instance.claude_bin");
    expect(problems({ ...base(), instance: { claude_rc_args: "--a --b" } })).toContain("instance.claude_rc_args");
    expect(problems({ ...base(), instance: { claude_rc_args: [1] } })).toContain("instance.claude_rc_args");
  });
});

describe("node mode config", () => {
  const nodeBase = () => ({
    mode: "node",
    tls: { state_dir: "/var/lib/rc", names: ["pi.internal", "10.0.0.9"] },
    node_auth: { secret: [{ sha256: "a".repeat(64) }] },
  });
  const node = (record: Record<string, unknown> = {}) => ({ ...nodeBase(), ...record });

  const K1 = Buffer.alloc(32, 1).toString("base64url");
  const K2 = Buffer.alloc(32, 2).toString("base64url");
  test("a valid node file parses; hub keys keep their order", () => {
    const config = parseConfig(
      node({ node_auth: { hub_key: [{ public_key: K1 }, { public_key: K2 }], secret: [{ sha256: "b".repeat(64) }] } }),
      io,
    );
    expect(config.mode).toBe("node");
    expect(config.publicUrl).toBe("");
    expect(config.userAuth).toBeUndefined();
    expect(config.node).toEqual({
      tls: { stateDir: "/var/lib/rc", names: ["pi.internal", "10.0.0.9"] },
      auth: { hubKeys: [K1, K2], secretHashes: ["b".repeat(64)] },
    });
  });
  test("state_dir defaults to /var/lib/claude-rc-launcher", () => {
    const harness = nodeBase();
    expect(defined(parseConfig({ ...harness, tls: { names: ["x"] } }, io).node).tls.stateDir).toBe(
      "/var/lib/claude-rc-launcher",
    );
  });
  test("[tls] and names are required and non-empty; a node_auth method is required", () => {
    expect(problems({ mode: "node", node_auth: nodeBase().node_auth })).toContain("tls");
    expect(problems(node({ tls: { names: [] } }))).toContain("tls.names");
    expect(problems(node({ tls: { state_dir: "/x" } }))).toContain("tls.names");
    expect(problems({ mode: "node", tls: nodeBase().tls })).toContain("node_auth");
    expect(problems(node({ node_auth: {} }))).toContain("node_auth");
  });
  test("node_auth validation: sha256 is 64 hex, public_key is 32 bytes of base64url", () => {
    expect(problems(node({ node_auth: { secret: [{ sha256: "xyz" }] } }))).toContain("node_auth.secret[0].sha256");
    expect(problems(node({ node_auth: { hub_key: [{ public_key: K1 }, { public_key: "AAAA" }] } }))).toContain(
      "node_auth.hub_key[1].public_key",
    );
    expect(problems(node({ node_auth: { hub_key: [{ public_key: "not base64url!" }] } }))).toContain(
      "node_auth.hub_key[0].public_key",
    );
    expect(problems(node({ node_auth: { hub_key: [{}] } }))).toContain("node_auth.hub_key[0].public_key");
  });
  test("[node_auth.oidc] is rejected and points to node_auth.hub_key", () => {
    expect(
      problems(
        node({ node_auth: { oidc: { jwks_url: "https://a/j", issuer: "i", audience: "a", caller_value: "c" } } }),
      ),
    ).toContain("node_auth.hub_key");
  });
  test("a node needs a hub_key or a secret", () => {
    expect(defined(parseConfig(node({ node_auth: { hub_key: [{ public_key: K1 }] } }), io).node).auth.hubKeys).toEqual([
      K1,
    ]);
    expect(defined(parseConfig(node(), io).node).auth.secretHashes).toHaveLength(1);
  });
  test("hub-only keys in a node file name each key", () => {
    for (const [key, value] of [
      ["public_url", "https://x"],
      ["user_auth", {}],
      ["hub_auth", {}],
      ["hosts", []],
    ] as const)
      expect(problems(node({ [key]: value }))).toContain(key);
  });
  test("a hub file with [hub_auth] fails and says it was removed in favour of hub_key", () => {
    const item = problems({ ...base(), hub_auth: { oidc: { token_url: "https://a/t", client_id: "h" } } });
    expect(item).toContain("hub_auth was removed");
    expect(item).toContain("hub_key");
  });
  test("[tls] or [node_auth] in a hub file is an error", () => {
    expect(problems({ ...base(), tls: { names: ["x"] } })).toContain("tls");
    expect(problems({ ...base(), node_auth: {} })).toContain("node_auth");
  });
  test("mode other than hub/node is an error", () => {
    expect(problems({ ...base(), mode: "relay" })).toContain("mode");
  });
});

describe("loadConfigFile", () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), "rc-cfg-"));
  const toml = `
public_url = "https://rc.example.com"
[user_auth]
mode = "oidc"
session_secret_file = "session.secret"
[user_auth.oidc]
issuer = "https://auth.example.com/o/rc/"
client_id = "id"
client_secret_file = "oidc.secret"
`;

  function setup(secretMode = 0o600) {
    const tmp = dir();
    writeFileSync(path.join(tmp, "config.toml"), toml);
    writeFileSync(path.join(tmp, "session.secret"), "s".repeat(40) + "\n");
    writeFileSync(path.join(tmp, "oidc.secret"), "client-secret\n");
    if (process.platform !== "win32")
      for (const entry of ["session.secret", "oidc.secret"]) chmodSync(path.join(tmp, entry), secretMode);
    return tmp;
  }

  test("parses TOML, resolves relative files against the config dir, trims one trailing newline", () => {
    const harness = setup();
    const config = loadConfigFile(path.join(harness, "config.toml"));
    expect(oa(config).oidc.clientSecret).toBe("client-secret");
    expect(oa(config).sessionSecret).toBe("s".repeat(40));
  });

  test.skipIf(process.platform === "win32")("rejects a group-readable secret file naming that file", () => {
    const harness = setup(0o640);
    expect(() => loadConfigFile(path.join(harness, "config.toml"))).toThrow(/oidc\.secret|session\.secret/);
  });

  test("invalid TOML and missing file are ConfigErrors", () => {
    const tmp = dir();
    writeFileSync(path.join(tmp, "bad.toml"), "this is = = not toml [");
    expect(() => loadConfigFile(path.join(tmp, "bad.toml"))).toThrow(ConfigError);
    expect(() => loadConfigFile(path.join(tmp, "missing.toml"))).toThrow(ConfigError);
  });
});

describe("resolveConfigPath", () => {
  test("--config beats env beats default", () => {
    expect(resolveConfigPath(["bun", "x", "--config", "a.toml"], { CLAUDE_RC_CONFIG: "b.toml" })).toBe("a.toml");
    expect(resolveConfigPath(["bun", "x"], { CLAUDE_RC_CONFIG: "b.toml" })).toBe("b.toml");
    expect(resolveConfigPath(["bun", "x"], {})).toBe("/etc/claude-rc-launcher/config.toml");
  });
});

describe("applyLocal", () => {
  const hub = () => parseConfig({ ...base(), port: 8181 }, io);
  test("without --local the config is unchanged", () => {
    const cfg = hub();
    expect(applyLocal(cfg, ["bun", "x"])).toBe(cfg);
  });
  test("--local sets the public URL to http://localhost:<port>", () => {
    expect(applyLocal(hub(), ["bun", "x", "--local"]).publicUrl).toBe("http://localhost:8181");
  });
  test("--local follows the configured port", () => {
    expect(applyLocal(parseConfig({ ...base(), port: 9000 }, io), ["--local"]).publicUrl).toBe("http://localhost:9000");
  });
  test("--local on a node is an error", () => {
    expect(() => applyLocal({ ...hub(), mode: "node" }, ["--local"])).toThrow(ConfigError);
  });
});

describe("hub state_dir and [cli_auth]", () => {
  const cli = (record: Record<string, unknown> = {}) => ({
    ...base(),
    cli_auth: {
      oidc: {
        issuer: "https://auth.example.com/application/o/cli/",
        client_id: "cli",
        jwks_url: "https://auth.example.com/application/o/cli/jwks/",
        ...record,
      },
    },
  });
  test("state_dir defaults to /var/lib/claude-rc-launcher and is read when set", () => {
    expect(parseConfig(base(), io).stateDir).toBe("/var/lib/claude-rc-launcher");
    expect(parseConfig({ ...base(), state_dir: "/x" }, io).stateDir).toBe("/x");
  });
  test("a relative state_dir is a problem naming state_dir", () => {
    expect(problems({ ...base(), state_dir: "rel" })).toContain("state_dir must be an absolute path");
  });
  test("[cli_auth.oidc] parses issuer, client_id and jwks_url; absent means undefined", () => {
    expect(parseConfig(base(), io).cliAuth).toBeUndefined();
    expect(parseConfig(cli(), io).cliAuth).toEqual({
      issuer: "https://auth.example.com/application/o/cli/",
      clientId: "cli",
      jwksUrl: "https://auth.example.com/application/o/cli/jwks/",
    });
  });
  test("cli_auth needs all three keys", () => {
    for (const key of ["issuer", "client_id", "jwks_url"]) {
      const item = cli() as any;
      delete item.cli_auth.oidc[key];
      expect(problems(item)).toContain(`cli_auth.oidc.${key} is required`);
    }

    expect(problems({ ...base(), cli_auth: {} })).toContain("cli_auth.oidc is required");
  });
  test("cli_auth rejects secret keys", () => {
    expect(problems(cli({ client_secret_file: "x" }))).toContain("unknown key cli_auth.oidc.client_secret_file");
    expect(problems({ ...cli(), cli_auth: { ...(cli() as any).cli_auth, token_secret_file: "x" } })).toContain(
      "unknown key cli_auth.token_secret_file",
    );
  });
  test("cli_auth.oidc.issuer must be https; loopback http and allow_insecure are the only exceptions", () => {
    expect(problems(cli({ issuer: "http://auth.example.com/o/" }))).toContain("cli_auth.oidc.issuer must be https");
    expect(parseConfig(cli({ issuer: "http://127.0.0.1:9000/o/" }), io).cliAuth?.issuer).toBe(
      "http://127.0.0.1:9000/o/",
    );
    expect(parseConfig(cli({ issuer: "http://auth.example.com/o/", allow_insecure: true }), io).cliAuth).toBeDefined();
  });
  test("cli_auth.oidc.jwks_url must be https", () => {
    expect(problems(cli({ jwks_url: "http://auth.example.com/jwks/" }))).toContain(
      "cli_auth.oidc.jwks_url must be https",
    );
  });
  test("node mode rejects cli_auth and top-level state_dir", () => {
    const node = { mode: "node", tls: { names: ["n"] }, node_auth: { secret: [{ sha256: "a".repeat(64) }] } };
    expect(problems({ ...node, cli_auth: {} })).toContain("cli_auth is not allowed in node mode");
    expect(problems({ ...node, state_dir: "/x" })).toContain("state_dir is not allowed in node mode");
  });
});
