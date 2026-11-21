import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsResult } from "../../scripts/authentik/apps";
import { snippet, writeHubConfig, writeSecret } from "../../scripts/authentik/hubconfig";
import { DEFAULTS } from "../../scripts/authentik/settings";
import { defined } from "./support";

const appsResult: AppsResult = {
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
    const item = snippet(appsResult, DEFAULTS);

    for (const need of [
      'issuer = "https://auth.example.org/application/o/claude-rc-launcher/"',
      'client_id = "web-id"',
      'client_id = "cli-id"',
      'role_claim = "clauderc_role"',
      'role_scope = "clauderc"',
      'jwks_url = "https://auth.example.org/application/o/claude-rc-cli/jwks/"',
      'client_secret_file = "oidc-client.secret"',
    ]) {
      expect(item).toContain(need);
    }

    expect(item).not.toContain("TOP-SECRET-VALUE");
  });
  test("uses a renamed claim and scope", () => {
    const item = snippet(appsResult, { ...DEFAULTS, claim: "my_role", scope: "myscope" });
    expect(item).toContain('role_claim = "my_role"');
    expect(item).toContain('role_scope = "myscope"');
  });
});

describe("writeSecret", () => {
  test("creates a file with mode 600 and refuses to replace it without force", () => {
    const file = join(dir(), "s");
    expect(writeSecret(file, "one", false)).toBe("written");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(writeSecret(file, "two", false)).toBe("kept");
    expect(readFileSync(file, "utf8").trim()).toBe("one");
    expect(writeSecret(file, "two", true)).toBe("written");
    expect(readFileSync(file, "utf8").trim()).toBe("two");
  });
});

describe("writeHubConfig", () => {
  test("sets the known keys, keeps comments and other tables, and writes a backup first", () => {
    const tmp = dir();
    writeFileSync(join(tmp, "config.toml"), EXAMPLE);
    const config = writeHubConfig(tmp, appsResult, DEFAULTS, false);
    const fileSync = readFileSync(join(tmp, "config.toml"), "utf8");
    expect(config.backup).toBe(join(tmp, "config.toml.bak"));
    expect(readFileSync(defined(config.backup), "utf8")).toBe(EXAMPLE);
    expect(fileSync).toContain('client_id = "web-id"');
    expect(fileSync).toContain('issuer = "https://auth.example.org/application/o/claude-rc-launcher/"');
    expect(fileSync).toContain("[cli_auth.oidc]");
    expect(fileSync).toContain('client_id = "cli-id"');
    expect(fileSync).toContain('role_claim = "clauderc_role"');
    expect(fileSync).toContain('# name = "home-server"');
    expect(fileSync).toContain("[instance]");
    expect(fileSync).not.toContain("replace-with-client-id");
    expect(fileSync).not.toContain("TOP-SECRET-VALUE");
  });
  test("a key with a real different value is kept unless force, and is reported", () => {
    const tmp = dir();
    writeFileSync(
      join(tmp, "config.toml"),
      '[user_auth.oidc]\nissuer = "https://real.example.net/application/o/x/"\nclient_id = "mine"\n',
    );
    const config = writeHubConfig(tmp, appsResult, DEFAULTS, false);
    expect(readFileSync(join(tmp, "config.toml"), "utf8")).toContain('client_id = "mine"');
    expect(config.kept).toContain("user_auth.oidc.client_id");
    const result = writeHubConfig(tmp, appsResult, DEFAULTS, true);
    expect(readFileSync(join(tmp, "config.toml"), "utf8")).toContain('client_id = "web-id"');
    expect(result.changed).toContain("user_auth.oidc.client_id");
  });
  test("adds the tables when they are missing", () => {
    const tmp = dir();
    writeFileSync(join(tmp, "config.toml"), 'mode = "hub"\nport = 8080\n');
    writeHubConfig(tmp, appsResult, DEFAULTS, false);
    const fileSync = readFileSync(join(tmp, "config.toml"), "utf8");
    expect(fileSync).toContain("[user_auth.oidc]");
    expect(fileSync).toContain("[cli_auth.oidc]");
    expect(fileSync).toContain('mode = "hub"');
  });
  test("a second run changes nothing and makes no backup", () => {
    const tmp = dir();
    writeFileSync(join(tmp, "config.toml"), EXAMPLE);
    writeHubConfig(tmp, appsResult, DEFAULTS, false);
    const before = readFileSync(join(tmp, "config.toml"), "utf8");
    const again = writeHubConfig(tmp, appsResult, DEFAULTS, false);
    expect(again.changed).toEqual([]);
    expect(readFileSync(join(tmp, "config.toml"), "utf8")).toBe(before);
  });
  test("a missing config.toml is a plain error", () => {
    expect(() => writeHubConfig(dir(), appsResult, DEFAULTS, false)).toThrow(/config\.toml/);
    expect(existsSync(join(dir(), "config.toml.bak"))).toBe(false);
  });
  test("the shipped template, with comments after its headers, stays valid TOML with the right values", () => {
    const tmp = dir();
    writeFileSync(join(tmp, "config.toml"), EXAMPLE);
    writeHubConfig(tmp, appsResult, DEFAULTS, false);
    const entry = Bun.TOML.parse(readFileSync(join(tmp, "config.toml"), "utf8")) as any;
    expect(entry.user_auth.role_claim).toBe("clauderc_role");
    expect(entry.user_auth.mode).toBe("oidc");
    expect(entry.user_auth.oidc.client_id).toBe("web-id");
    expect(entry.cli_auth.oidc.client_id).toBe("cli-id");
  });
  test("single-quoted values are replaced, and a comment after a value stays", () => {
    const tmp = dir();
    writeFileSync(
      join(tmp, "config.toml"),
      "[user_auth.oidc]\nissuer = 'https://auth.example.com/x/'   # must be https\nclient_id = 'replace-with-client-id'\n",
    );
    writeHubConfig(tmp, appsResult, DEFAULTS, false);
    const text = readFileSync(join(tmp, "config.toml"), "utf8");
    expect(text).toContain("# must be https");
    const entry = Bun.TOML.parse(text) as any;
    expect(entry.user_auth.oidc.issuer).toBe(appsResult.issuer);
    expect(entry.user_auth.oidc.client_id).toBe("web-id");
  });
  test("a form that the editor cannot follow (dotted keys) is refused and nothing is written", () => {
    const tmp = dir();
    const original = '[user_auth]\nmode = "oidc"\noidc.issuer = "https://old.example.net/"\n';
    writeFileSync(join(tmp, "config.toml"), original);
    expect(() => writeHubConfig(tmp, appsResult, DEFAULTS, false)).toThrow(/nothing was written/i);
    expect(readFileSync(join(tmp, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(tmp, "config.toml.bak"))).toBe(false);
  });
});
