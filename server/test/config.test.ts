import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config";

const base = {
  PUBLIC_URL: "https://rc.example.com",
  OIDC_ISSUER: "https://auth.example.com/application/o/rc/",
  OIDC_CLIENT_ID: "id",
  OIDC_CLIENT_SECRET: "secret",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadConfig", () => {
  test("defaults", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.host).toBe("0.0.0.0");
    expect(c.scope).toBe("system");
    expect(c.unitDir).toBe("/etc/systemd/system");
    expect(c.claudeRcArgs).toEqual(["--spawn", "same-dir", "--no-create-session-in-dir"]);
    expect(c.claudeBin).toBe("/root/.local/bin/claude");
    expect(c.oidc.allowInsecure).toBe(false);
    expect(c.namePrefix).toBe("");
    expect(c.trustProxy).toBe(false);
    expect(c.serviceUser).toBe("root");
    expect(c.serviceHome).toBe("/root");
    expect(c.roots).toEqual(["/root"]);
    expect(c.servicePath).toBe("/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(c.sshAuthSock).toBeUndefined();
  });

  test("user scope unitDir", () => {
    const c = loadConfig({ ...base, SYSTEMD_SCOPE: "user", SERVICE_USER: "bob", SERVICE_HOME: "/home/bob" });
    expect(c.scope).toBe("user");
    expect(c.unitDir).toBe("/home/bob/.config/systemd/user");
  });

  test("home defaults to /home/<user>", () => {
    expect(loadConfig({ ...base, SERVICE_USER: "bob" }).serviceHome).toBe("/home/bob");
  });

  test("missing required vars are all named", () => {
    try {
      loadConfig({});
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      for (const k of ["PUBLIC_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_SECRET"])
        expect((e as Error).message).toContain(k);
    }
  });

  test("short SESSION_SECRET throws", () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: "short" })).toThrow(ConfigError);
  });

  test("ROOTS and CLAUDE_RC_ARGS", () => {
    const c = loadConfig({ ...base, ROOTS: "/a:/b", CLAUDE_RC_ARGS: "--x  --y z" });
    expect(c.roots).toEqual(["/a", "/b"]);
    expect(c.claudeRcArgs).toEqual(["--x", "--y", "z"]);
  });

  test("OIDC issuer transport", () => {
    expect(loadConfig(base).oidc.allowInsecure).toBe(false);
    const http = (o: Record<string, string>) => loadConfig({ ...base, ...o });
    expect(() => http({ OIDC_ISSUER: "http://auth.example.com" })).toThrow(/OIDC_ISSUER must be https.*OIDC_ALLOW_INSECURE/);
    expect(() => http({ OIDC_ISSUER: "ftp://auth.example.com" })).toThrow(ConfigError);
    expect(http({ OIDC_ISSUER: "http://localhost:9000" }).oidc.issuer).toBe("http://localhost:9000");
    expect(http({ OIDC_ISSUER: "http://127.0.0.1:9000/x" }).oidc.issuer).toBe("http://127.0.0.1:9000/x");
    expect(http({ OIDC_ISSUER: "http://[::1]:9000" }).oidc.issuer).toBe("http://[::1]:9000");
    const c = http({ OIDC_ISSUER: "http://auth.example.com", OIDC_ALLOW_INSECURE: "true" });
    expect(c.oidc.allowInsecure).toBe(true);
    expect(() => http({ OIDC_ISSUER: "http://localhost.evil.com" })).toThrow(ConfigError);
  });

  test("CLAUDE_BIN must be absolute; default under SERVICE_HOME", () => {
    expect(loadConfig({ ...base, SERVICE_USER: "bob" }).claudeBin).toBe("/home/bob/.local/bin/claude");
    expect(loadConfig({ ...base, CLAUDE_BIN: "/opt/claude" }).claudeBin).toBe("/opt/claude");
    expect(() => loadConfig({ ...base, CLAUDE_BIN: "claude" })).toThrow(/CLAUDE_BIN/);
  });

  test("ROOTS entries must be absolute", () => {
    expect(() => loadConfig({ ...base, ROOTS: "/a:rel/path" })).toThrow(/ROOTS.*rel\/path/);
    expect(loadConfig({ ...base, ROOTS: "/a" }).roots).toEqual(["/a"]);
  });
});
