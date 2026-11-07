import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";
import { defaultName, instanceId, isValidName, parseManaged, renderUnit, unitName } from "../src/unit";

const KEYS: Record<string, string> = {
  CLAUDE_BIN: "claude_bin", NAME_PREFIX: "name_prefix", SERVICE_HOME: "service_home", SERVICE_PATH: "service_path",
  SERVICE_USER: "service_user", SSH_AUTH_SOCK: "ssh_auth_sock", SYSTEMD_SCOPE: "scope",
};
const cfg = (extra: Record<string, string> = {}) => {
  const instance: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) instance[KEYS[k] ?? (k === "CLAUDE_RC_ARGS" ? "claude_rc_args" : k)] = k === "CLAUDE_RC_ARGS" ? v.split(/\s+/).filter(Boolean) : v;
  return parseConfig(
    {
      public_url: "https://x",
      instance,
      user_auth: { mode: "oidc", session_secret_file: "s", oidc: { issuer: "https://i", client_id: "c", client_secret_file: "c" } },
    },
    { readFile: () => "x".repeat(32) },
  );
};
const withSock = () => cfg({ SSH_AUTH_SOCK: "/run/ssh-agent.sock" });
const P = "/srv/claude/projects/monitoring";
const BS = String.fromCharCode(92);

describe("renderUnit", () => {
  test("matches proven template", () => {
    const out = renderUnit(withSock(), P, "myhost-monitoring");
    const expected = [
      `# managed-by: claude-rc-launcher path=${P}`,
      "[Unit]",
      "Description=Claude Code Remote Control Server",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=root",
      `WorkingDirectory=${P}`,
      `Environment="HOME=/root"`,
      `Environment="PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
      `Environment="SSH_AUTH_SOCK=/run/ssh-agent.sock"`,
      "ExecStart=/root/.local/bin/claude remote-control --name myhost-monitoring --spawn same-dir --no-create-session-in-dir",
      "StandardOutput=null",
      "StandardError=journal",
      "Restart=always",
      "RestartSec=10",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ];
    expect(out.split("\n")).toEqual(expected);
  });

  test("no SSH_AUTH_SOCK without config", () => {
    expect(renderUnit(cfg(), P, "n")).not.toContain("SSH_AUTH_SOCK");
  });

  test("User comes from config", () => {
    expect(renderUnit(cfg({ SERVICE_USER: "bob" }), P, "n")).toContain("\nUser=bob\n");
  });

  test("marker round-trips; non-marker is null", () => {
    expect(parseManaged(renderUnit(cfg(), P, "n"))).toEqual({ path: P });
    expect(parseManaged("[Unit]\nDescription=x\n")).toBeNull();
    expect(parseManaged("")).toBeNull();
  });

  test("hostile path is escaped", () => {
    const p = '/srv/my "proj" 100%$x é';
    const out = renderUnit(cfg(), p, "n");
    expect(out).toContain('WorkingDirectory=/srv/my "proj" 100%%$x é\n');
    expect(out.split("\n").filter((l) => l.startsWith("ExecStart="))).toEqual([
      "ExecStart=/root/.local/bin/claude remote-control --name n --spawn same-dir --no-create-session-in-dir",
    ]);
    expect(parseManaged(out)).toEqual({ path: p });
  });

  test("control chars throw", () => {
    expect(() => renderUnit(cfg(), "/a\nb", "n")).toThrow();
    expect(() => renderUnit(cfg(), "/a\u0001b", "n")).toThrow();
    expect(() => renderUnit(cfg(), "/a\rb", "n")).toThrow();
    expect(() => renderUnit(cfg(), "/a\u007fb", "n")).toThrow();
  });

  test("backslash and edge whitespace in path throw", () => {
    expect(() => renderUnit(cfg(), "/srv/x" + BS, "n")).toThrow();
    expect(() => renderUnit(cfg(), "/srv/a" + BS + "b/c", "n")).toThrow();
    expect(() => renderUnit(cfg(), "/srv/x ", "n")).toThrow();
    expect(() => renderUnit(cfg(), "/srv/x\t", "n")).toThrow();
  });

  test("control chars in claudeRcArgs and sshAuthSock throw", () => {
    expect(() => renderUnit(cfg({ CLAUDE_RC_ARGS: "--a --b\u0001c" }), P, "n")).toThrow();
    expect(() => renderUnit(cfg({ CLAUDE_BIN: "cl\naude" }), P, "n")).toThrow();
    expect(() => renderUnit(cfg({ SSH_AUTH_SOCK: "/run/a\nExecStartPre=x" }), P, "n")).toThrow();
    expect(() => renderUnit(cfg({ SERVICE_USER: "bob" + BS }), P, "n")).toThrow();
  });

  test("relative path throws", () => {
    expect(() => renderUnit(cfg(), "rel/dir", "n")).toThrow();
  });

  test("invalid name throws", () => {
    expect(() => renderUnit(cfg(), P, "a b")).toThrow();
    expect(() => renderUnit(cfg(), P, "")).toThrow();
  });

  test("claudeBin with space is double-quoted; specials escaped", () => {
    const out = renderUnit(cfg({ CLAUDE_BIN: "/opt/my claude/bin/claude" }), P, "n");
    expect(out).toContain('ExecStart="/opt/my claude/bin/claude" remote-control --name n');
    const out2 = renderUnit(cfg({ CLAUDE_BIN: String.raw`/o/a"b$c%d\e` }), P, "n");
    expect(out2).toContain(String.raw`ExecStart="/o/a\"b$$c%%d\\e" remote-control`);
  });

  test("Environment values escape quotes, backslashes and %", () => {
    const out = renderUnit(cfg({ SERVICE_HOME: String.raw`/h/a"b%c\d` }), P, "n");
    expect(out).toContain(String.raw`Environment="HOME=/h/a\"b%%c\\d"`);
  });

  test("control chars in config values throw", () => {
    expect(() => renderUnit(cfg({ SERVICE_PATH: "/a\nExecStartPre=x" }), P, "n")).toThrow();
    expect(() => renderUnit(cfg({ SERVICE_USER: "root\nUser=x" }), P, "n")).toThrow();
  });
});

describe("names and ids", () => {
  test("isValidName", () => {
    expect(isValidName("myhost-monitoring_1.x")).toBe(true);
    expect(isValidName("")).toBe(false);
    expect(isValidName("a".repeat(65))).toBe(false);
    expect(isValidName("a".repeat(64))).toBe(true);
    expect(isValidName("a b")).toBe(false);
    expect(isValidName("a/b")).toBe(false);
    expect(isValidName("-x")).toBe(false);
    expect(isValidName("--dangerously-skip-permissions")).toBe(false);
    expect(isValidName("a-b")).toBe(true);
  });

  test("instanceId stable 12 hex", () => {
    expect(instanceId(P)).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId(P)).toBe(instanceId(P));
    expect(instanceId(P)).not.toBe(instanceId(P + "2"));
    expect(unitName("abc")).toBe("claude-rc-abc.service");
  });

  test("defaultName", () => {
    expect(defaultName(cfg({ NAME_PREFIX: "myhost-" }), P)).toBe("myhost-monitoring");
    expect(defaultName(cfg(), "/x/my proj é")).toBe("my-proj--");
    expect(defaultName(cfg(), "/")).toBe("claude");
    expect(defaultName(cfg(), "/x/" + "a".repeat(100))).toHaveLength(64);
    expect(isValidName(defaultName(cfg(), "/x/we ird$"))).toBe(true);
    expect(defaultName(cfg(), "/x/--dangerously-skip-permissions")).toBe("dangerously-skip-permissions");
    expect(defaultName(cfg(), "/x/---")).toBe("claude");
    expect(defaultName(cfg({ NAME_PREFIX: "-" }), "/x/p")).toBe("p");
  });
});

describe("flag injection and scope", () => {
  test("renderUnit rejects a name starting with '-'", () => {
    expect(() => renderUnit(cfg(), P, "--dangerously-skip-permissions")).toThrow();
    expect(() => renderUnit(cfg(), P, "-x")).toThrow();
  });

  test("system scope has User= and multi-user.target", () => {
    const out = renderUnit(cfg(), P, "n");
    expect(out).toContain("\nUser=root\n");
    expect(out).toContain("WantedBy=multi-user.target");
  });

  test("user scope: WantedBy=default.target and no User=", () => {
    const out = renderUnit(cfg({ SYSTEMD_SCOPE: "user", SERVICE_USER: "bob" }), P, "n");
    expect(out).toContain("WantedBy=default.target");
    expect(out).not.toContain("multi-user.target");
    expect(out.split("\n").some((l) => l.startsWith("User="))).toBe(false);
  });
});
