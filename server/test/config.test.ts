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
    expect(c.claudeBin).toBe("claude");
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
});
