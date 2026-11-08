import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, parseConfig, type Config, type ConfigIo, type OidcUserAuth } from "../src/config";
import { loadConfigFile, resolveConfigPath } from "../src/configfile";

const oa = (c: Config) => c.userAuth as OidcUserAuth;
const io: ConfigIo = { readFile: () => "x".repeat(40) };

const base = () => ({
  public_url: "https://rc.example.com",
  user_auth: {
    mode: "oidc",
    session_secret_file: "session.secret",
    oidc: { issuer: "https://auth.example.com/application/o/rc/", client_id: "id", client_secret_file: "oidc.secret" },
  },
});
const withOidc = (o: Record<string, unknown>) => {
  const b = base();
  return { ...b, user_auth: { ...b.user_auth, oidc: { ...b.user_auth.oidc, ...o } } };
};
const problems = (raw: unknown): string => {
  try {
    parseConfig(raw, io);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("no throw");
};

describe("parseConfig", () => {
  test("defaults", () => {
    const c = parseConfig(base(), io);
    expect(c.mode).toBe("hub");
    expect(c.name).toBe(os.hostname());
    expect(c.port).toBe(8080);
    expect(c.host).toBe("0.0.0.0");
    expect(c.scope).toBe("system");
    expect(c.unitDir).toBe("/etc/systemd/system");
    expect(c.claudeRcArgs).toEqual(["--spawn", "same-dir", "--no-create-session-in-dir"]);
    expect(c.claudeBin).toBe("/root/.local/bin/claude");
    expect(c.roots).toEqual(["/root"]);
    expect(c.serviceUser).toBe("root");
    expect(c.serviceHome).toBe("/root");
    expect(c.namePrefix).toBe("");
    expect(c.sshAuthSock).toBeUndefined();
    expect(oa(c).oidc.allowInsecure).toBe(false);
    expect(oa(c).oidc.clientSecret).toHaveLength(40);
  });

  test("[instance] keys map to fields; user scope defaults unit dir; home defaults to /home/<user>", () => {
    const c = parseConfig(
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
    expect(c).toMatchObject({
      name: "box", port: 9000, host: "127.0.0.1", roots: ["/a", "/b"], scope: "user", serviceUser: "bob", serviceHome: "/home/bob",
      unitDir: "/home/bob/.config/systemd/user", claudeBin: "/opt/claude", claudeRcArgs: ["--x"], namePrefix: "p-", sshAuthSock: "/s", servicePath: "/bin",
    });
  });

  test("unknown keys are errors naming the dotted path", () => {
    expect(problems({ ...base(), instance: { rootz: ["/a"] } })).toContain("instance.rootz");
    expect(problems({ ...base(), trust_proxy: true })).toContain("trust_proxy");
    expect(problems(withOidc({ client_secret: "inline" }))).toContain("user_auth.oidc.client_secret");
  });

  test("missing required keys are all named in one error", () => {
    const m = problems({});
    expect(m).toContain("public_url");
    expect(m).toContain("user_auth");
    const n = problems({ public_url: "https://x", user_auth: { mode: "oidc", oidc: {} } });
    for (const k of ["user_auth.oidc.issuer", "user_auth.oidc.client_id", "user_auth.oidc.client_secret_file", "user_auth.session_secret_file"])
      expect(n).toContain(k);
  });

  test("user_auth.mode is required and has no unauthenticated value", () => {
    expect(problems({ public_url: "https://x", user_auth: {} })).toContain("user_auth.mode");
    expect(problems({ public_url: "https://x", user_auth: { mode: "none" } })).toContain("user_auth.mode");
  });

  test("allowed_users: array of strings; empty array rejected naming the key", () => {
    const b = base();
    expect(oa(parseConfig({ ...b, user_auth: { ...b.user_auth, allowed_users: ["kir"] } }, io)).allowedUsers).toEqual(["kir"]);
    expect(problems({ ...b, user_auth: { ...b.user_auth, allowed_users: [] } })).toContain("user_auth.allowed_users");
    expect(oa(parseConfig(b, io)).allowedUsers).toBeUndefined();
  });

  test("short session secret", () => {
    const short: ConfigIo = { readFile: (p) => (p.includes("session") ? "short" : "x".repeat(40)) };
    expect(() => parseConfig(base(), short)).toThrow(/session_secret_file.*32/);
  });

  test("OIDC issuer transport", () => {
    expect(problems(withOidc({ issuer: "http://auth.example.com" }))).toMatch(/user_auth\.oidc\.issuer must be https.*allow_insecure/);
    expect(problems(withOidc({ issuer: "ftp://auth.example.com" }))).toContain("issuer");
    for (const u of ["http://localhost:9000", "http://127.0.0.1:9000/x", "http://[::1]:9000"])
      expect(oa(parseConfig(withOidc({ issuer: u }), io)).oidc.issuer).toBe(u);
    const c = parseConfig(withOidc({ issuer: "http://auth.example.com", allow_insecure: true }), io);
    expect(oa(c).oidc.allowInsecure).toBe(true);
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
  const node = (o: Record<string, unknown> = {}) => ({ ...nodeBase(), ...o });

  const K1 = Buffer.alloc(32, 1).toString("base64url");
  const K2 = Buffer.alloc(32, 2).toString("base64url");
  test("a valid node file parses; hub keys keep their order", () => {
    const c = parseConfig(node({ node_auth: { hub_key: [{ public_key: K1 }, { public_key: K2 }], secret: [{ sha256: "b".repeat(64) }] } }), io);
    expect(c.mode).toBe("node");
    expect(c.publicUrl).toBe("");
    expect(c.userAuth).toBeUndefined();
    expect(c.node).toEqual({
      tls: { stateDir: "/var/lib/rc", names: ["pi.internal", "10.0.0.9"] },
      auth: { hubKeys: [K1, K2], secretHashes: ["b".repeat(64)] },
    });
  });
  test("state_dir defaults to /var/lib/claude-rc-launcher", () => {
    const n = nodeBase();
    expect(parseConfig({ ...n, tls: { names: ["x"] } }, io).node!.tls.stateDir).toBe("/var/lib/claude-rc-launcher");
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
    expect(problems(node({ node_auth: { hub_key: [{ public_key: K1 }, { public_key: "AAAA" }] } }))).toContain("node_auth.hub_key[1].public_key");
    expect(problems(node({ node_auth: { hub_key: [{ public_key: "not base64url!" }] } }))).toContain("node_auth.hub_key[0].public_key");
    expect(problems(node({ node_auth: { hub_key: [{}] } }))).toContain("node_auth.hub_key[0].public_key");
  });
  test("[node_auth.oidc] is rejected and points to node_auth.hub_key", () => {
    expect(problems(node({ node_auth: { oidc: { jwks_url: "https://a/j", issuer: "i", audience: "a", caller_value: "c" } } }))).toContain("node_auth.hub_key");
  });
  test("a node needs a hub_key or a secret", () => {
    expect(parseConfig(node({ node_auth: { hub_key: [{ public_key: K1 }] } }), io).node!.auth.hubKeys).toEqual([K1]);
    expect(parseConfig(node(), io).node!.auth.secretHashes).toHaveLength(1);
  });
  test("hub-only keys in a node file name each key", () => {
    for (const [k, v] of [["public_url", "https://x"], ["user_auth", {}], ["hub_auth", {}], ["hosts", []]] as const)
      expect(problems(node({ [k]: v }))).toContain(k);
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
    const d = dir();
    writeFileSync(path.join(d, "config.toml"), toml);
    writeFileSync(path.join(d, "session.secret"), "s".repeat(40) + "\n");
    writeFileSync(path.join(d, "oidc.secret"), "client-secret\n");
    if (process.platform !== "win32") for (const f of ["session.secret", "oidc.secret"]) chmodSync(path.join(d, f), secretMode);
    return d;
  }

  test("parses TOML, resolves relative files against the config dir, trims one trailing newline", () => {
    const d = setup();
    const c = loadConfigFile(path.join(d, "config.toml"));
    expect(oa(c).oidc.clientSecret).toBe("client-secret");
    expect(oa(c).sessionSecret).toBe("s".repeat(40));
  });

  test.skipIf(process.platform === "win32")("rejects a group-readable secret file naming that file", () => {
    const d = setup(0o640);
    expect(() => loadConfigFile(path.join(d, "config.toml"))).toThrow(/oidc\.secret|session\.secret/);
  });

  test("invalid TOML and missing file are ConfigErrors", () => {
    const d = dir();
    writeFileSync(path.join(d, "bad.toml"), "this is = = not toml [");
    expect(() => loadConfigFile(path.join(d, "bad.toml"))).toThrow(ConfigError);
    expect(() => loadConfigFile(path.join(d, "missing.toml"))).toThrow(ConfigError);
  });
});

describe("resolveConfigPath", () => {
  test("--config beats env beats default", () => {
    expect(resolveConfigPath(["bun", "x", "--config", "a.toml"], { CLAUDE_RC_CONFIG: "b.toml" })).toBe("a.toml");
    expect(resolveConfigPath(["bun", "x"], { CLAUDE_RC_CONFIG: "b.toml" })).toBe("b.toml");
    expect(resolveConfigPath(["bun", "x"], {})).toBe("/etc/claude-rc-launcher/config.toml");
  });
});

describe("hub state_dir and [cli_auth]", () => {
  const cli = (o: Record<string, unknown> = {}) => ({
    ...base(),
    cli_auth: { oidc: { issuer: "https://auth.example.com/application/o/cli/", client_id: "cli", jwks_url: "https://auth.example.com/application/o/cli/jwks/", ...o } },
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
    for (const k of ["issuer", "client_id", "jwks_url"]) {
      const c = cli() as any;
      delete c.cli_auth.oidc[k];
      expect(problems(c)).toContain(`cli_auth.oidc.${k} is required`);
    }
    expect(problems({ ...base(), cli_auth: {} })).toContain("cli_auth.oidc is required");
  });
  test("cli_auth rejects secret keys", () => {
    expect(problems(cli({ client_secret_file: "x" }))).toContain("unknown key cli_auth.oidc.client_secret_file");
    expect(problems({ ...cli(), cli_auth: { ...(cli() as any).cli_auth, token_secret_file: "x" } })).toContain("unknown key cli_auth.token_secret_file");
  });
  test("cli_auth.oidc.issuer must be https; loopback http and allow_insecure are the only exceptions", () => {
    expect(problems(cli({ issuer: "http://auth.example.com/o/" }))).toContain("cli_auth.oidc.issuer must be https");
    expect(parseConfig(cli({ issuer: "http://127.0.0.1:9000/o/" }), io).cliAuth?.issuer).toBe("http://127.0.0.1:9000/o/");
    expect(parseConfig(cli({ issuer: "http://auth.example.com/o/", allow_insecure: true }), io).cliAuth).toBeDefined();
  });
  test("cli_auth.oidc.jwks_url must be https", () => {
    expect(problems(cli({ jwks_url: "http://auth.example.com/jwks/" }))).toContain("cli_auth.oidc.jwks_url must be https");
  });
  test("node mode rejects cli_auth and top-level state_dir", () => {
    const node = { mode: "node", tls: { names: ["n"] }, node_auth: { secret: [{ sha256: "a".repeat(64) }] } };
    expect(problems({ ...node, cli_auth: {} })).toContain("cli_auth is not allowed in node mode");
    expect(problems({ ...node, state_dir: "/x" })).toContain("state_dir is not allowed in node mode");
  });
});
