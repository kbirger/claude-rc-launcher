import { describe, expect, test } from "bun:test";
import { DEFAULTS, parseSettings } from "../../scripts/authentik/settings";

const base = ["--public-url", "https://rc.example.com"];
const env = { AUTHENTIK_URL: "https://auth.example.com", AUTHENTIK_TOKEN: "t" };

describe("parseSettings", () => {
  test("defaults match the old constants", () => {
    const r = parseSettings(base, env);
    expect(r.settings).toEqual({ ...DEFAULTS });
    expect(r.apply).toBe(false);
    expect(r.interactive).toBe(false);
    expect(r.secretFile).toBe("./oidc-client.secret");
    expect(r.publicUrl).toBe("https://rc.example.com");
  });
  test("a flag wins over an environment variable", () => {
    const r = parseSettings([...base, "--claim", "from_flag"], { ...env, CLAUDERC_CLAIM: "from_env" });
    expect(r.settings.claim).toBe("from_flag");
    expect(parseSettings(base, { ...env, CLAUDERC_CLAIM: "from_env" }).settings.claim).toBe("from_env");
  });
  test("--group-prefix renames all three groups", () => {
    const r = parseSettings([...base, "--group-prefix", "team"], env);
    expect(r.settings.groups.map((g) => g.name)).toEqual(["team-admins", "team-writers", "team-ro"]);
    expect(r.settings.adminGroup).toBe("team-admins");
  });
  test("public url must be https unless loopback", () => {
    expect(() => parseSettings(["--public-url", "http://rc.example.com"], env)).toThrow(/https/);
    expect(parseSettings(["--public-url", "http://127.0.0.1:8080"], env).publicUrl).toBe("http://127.0.0.1:8080");
  });
  test("public url with a trailing slash is cleaned, and a path is refused", () => {
    expect(parseSettings(["--public-url", "https://rc.example.com/"], env).publicUrl).toBe("https://rc.example.com");
    expect(() => parseSettings(["--public-url", "https://rc.example.com/some/path/"], env)).toThrow(/without a path/);
  });
  test("a slug must match [a-z0-9-]+", () => {
    expect(() => parseSettings([...base, "--web-slug", "Bad Slug"], env)).toThrow(/slug/);
  });
  test("a missing public url is an error unless --interactive", () => {
    expect(() => parseSettings([], env)).toThrow(/--public-url/);
    expect(parseSettings(["--interactive"], env).interactive).toBe(true);
  });
  test("flags: apply, force, secret file, hub config, admin user, remove old hub", () => {
    const r = parseSettings([...base, "--apply", "--force", "--secret-file", "/tmp/s", "--write-hub-config", "/etc/x", "--admin-user", "kir", "--remove-old-hub"], env);
    expect(r).toMatchObject({ apply: true, force: true, secretFile: "/tmp/s", writeHubConfig: "/etc/x" });
    expect(r.settings.adminUser).toBe("kir");
    expect(r.settings.removeOldHub).toBe(true);
  });
  test("an unknown flag and a missing token are errors", () => {
    expect(() => parseSettings([...base, "--nope"], env)).toThrow(/unknown flag/);
    expect(() => parseSettings(base, { AUTHENTIK_URL: "https://a" })).toThrow(/AUTHENTIK_TOKEN/);
  });
  test("the authentik url must be https unless loopback", () => {
    expect(() => parseSettings(base, { AUTHENTIK_URL: "http://auth.example.com", AUTHENTIK_TOKEN: "t" })).toThrow(/https/);
  });
});
