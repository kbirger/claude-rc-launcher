import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsResult } from "../../scripts/authentik/apps";
import { snippet, writeHubConfig, writeSecret } from "../../scripts/authentik/hubconfig";
import { DEFAULTS } from "../../scripts/authentik/settings";

const R: AppsResult = {
  issuer: "https://auth.example.org/application/o/claude-rc-launcher/",
  webClientId: "web-id",
  webClientSecret: "TOP-SECRET-VALUE",
  cliClientId: "cli-id",
  cliIssuer: "https://auth.example.org/application/o/claude-rc-cli/",
  cliJwksUrl: "https://auth.example.org/application/o/claude-rc-cli/jwks/",
};
const dir = () => mkdtempSync(join(tmpdir(), "hubcfg-"));
const EXAMPLE = readFileSync(join(import.meta.dir, "../../deploy/config.example.toml"), "utf8");

describe("snippet", () => {
  test("has issuer, client ids, role claim, role scope and the CLI jwks url, and never the secret", () => {
    const t = snippet(R, DEFAULTS);
    for (const need of ['issuer = "https://auth.example.org/application/o/claude-rc-launcher/"', 'client_id = "web-id"', 'client_id = "cli-id"', 'role_claim = "clauderc_role"', 'role_scope = "clauderc"', 'jwks_url = "https://auth.example.org/application/o/claude-rc-cli/jwks/"', 'client_secret_file = "oidc-client.secret"']) {
      expect(t).toContain(need);
    }
    expect(t).not.toContain("TOP-SECRET-VALUE");
  });
  test("uses a renamed claim and scope", () => {
    const t = snippet(R, { ...DEFAULTS, claim: "my_role", scope: "myscope" });
    expect(t).toContain('role_claim = "my_role"');
    expect(t).toContain('role_scope = "myscope"');
  });
});

describe("writeSecret", () => {
  test("creates a file with mode 600 and refuses to replace it without force", () => {
    const f = join(dir(), "s");
    expect(writeSecret(f, "one", false)).toBe("written");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(writeSecret(f, "two", false)).toBe("kept");
    expect(readFileSync(f, "utf8").trim()).toBe("one");
    expect(writeSecret(f, "two", true)).toBe("written");
    expect(readFileSync(f, "utf8").trim()).toBe("two");
  });
});

describe("writeHubConfig", () => {
  test("sets the known keys, keeps comments and other tables, and writes a backup first", () => {
    const d = dir();
    writeFileSync(join(d, "config.toml"), EXAMPLE);
    const r = writeHubConfig(d, R, DEFAULTS, false);
    const t = readFileSync(join(d, "config.toml"), "utf8");
    expect(r.backup).toBe(join(d, "config.toml.bak"));
    expect(readFileSync(r.backup!, "utf8")).toBe(EXAMPLE);
    expect(t).toContain('client_id = "web-id"');
    expect(t).toContain('issuer = "https://auth.example.org/application/o/claude-rc-launcher/"');
    expect(t).toContain('[cli_auth.oidc]');
    expect(t).toContain('client_id = "cli-id"');
    expect(t).toContain('role_claim = "clauderc_role"');
    expect(t).toContain("# name = \"home-server\"");
    expect(t).toContain("[instance]");
    expect(t).not.toContain("replace-with-client-id");
    expect(t).not.toContain("TOP-SECRET-VALUE");
  });
  test("a key with a real different value is kept unless force, and is reported", () => {
    const d = dir();
    writeFileSync(join(d, "config.toml"), '[user_auth.oidc]\nissuer = "https://real.example.net/application/o/x/"\nclient_id = "mine"\n');
    const r = writeHubConfig(d, R, DEFAULTS, false);
    expect(readFileSync(join(d, "config.toml"), "utf8")).toContain('client_id = "mine"');
    expect(r.kept).toContain("user_auth.oidc.client_id");
    const f = writeHubConfig(d, R, DEFAULTS, true);
    expect(readFileSync(join(d, "config.toml"), "utf8")).toContain('client_id = "web-id"');
    expect(f.changed).toContain("user_auth.oidc.client_id");
  });
  test("adds the tables when they are missing", () => {
    const d = dir();
    writeFileSync(join(d, "config.toml"), 'mode = "hub"\nport = 8080\n');
    writeHubConfig(d, R, DEFAULTS, false);
    const t = readFileSync(join(d, "config.toml"), "utf8");
    expect(t).toContain("[user_auth.oidc]");
    expect(t).toContain("[cli_auth.oidc]");
    expect(t).toContain('mode = "hub"');
  });
  test("a second run changes nothing and makes no backup", () => {
    const d = dir();
    writeFileSync(join(d, "config.toml"), EXAMPLE);
    writeHubConfig(d, R, DEFAULTS, false);
    const before = readFileSync(join(d, "config.toml"), "utf8");
    const again = writeHubConfig(d, R, DEFAULTS, false);
    expect(again.changed).toEqual([]);
    expect(readFileSync(join(d, "config.toml"), "utf8")).toBe(before);
  });
  test("a missing config.toml is a plain error", () => {
    expect(() => writeHubConfig(dir(), R, DEFAULTS, false)).toThrow(/config\.toml/);
    expect(existsSync(join(dir(), "config.toml.bak"))).toBe(false);
  });
});
