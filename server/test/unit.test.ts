import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";
import {
  defaultName,
  instanceId,
  isValidName,
  parseManaged,
  execWords,
  parseUnitSettings,
  parseUnitUser,
  renderUnit,
  runAsFor,
  unitName,
} from "../src/unit";
import { defined } from "./support";

const KEYS: Record<string, string> = {
  CLAUDE_BIN: "claude_bin",
  NAME_PREFIX: "name_prefix",
  SERVICE_HOME: "service_home",
  SERVICE_PATH: "service_path",
  SERVICE_USER: "service_user",
  SSH_AUTH_SOCK: "ssh_auth_sock",
  SYSTEMD_SCOPE: "scope",
};

const cfg = (extra: Record<string, string> = {}) => {
  const instance: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra))
    instance[KEYS[key] ?? (key === "CLAUDE_RC_ARGS" ? "claude_rc_args" : key)] =
      key === "CLAUDE_RC_ARGS" ? value.split(/\s+/).filter(Boolean) : value;
  return parseConfig(
    {
      public_url: "https://x",
      instance,
      user_auth: {
        mode: "oidc",
        session_secret_file: "s",
        oidc: { issuer: "https://i", client_id: "c", client_secret_file: "c" },
      },
    },
    { readFile: () => "x".repeat(32) },
  );
};

const withSock = () => cfg({ SSH_AUTH_SOCK: "/run/ssh-agent.sock" });
const item = "/srv/claude/projects/monitoring";
const BS = String.fromCharCode(92);

describe("renderUnit", () => {
  test("matches proven template", () => {
    const out = renderUnit(withSock(), item, "myhost-monitoring");
    const expected = [
      `# managed-by: claude-rc-launcher path=${item}`,
      "[Unit]",
      "Description=Claude Code Remote Control Server",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=root",
      `WorkingDirectory=${item}`,
      `Environment="HOME=/root"`,
      `Environment="PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
      `Environment="SSH_AUTH_SOCK=/run/ssh-agent.sock"`,
      "ExecStart=/root/.local/bin/claude remote-control --name myhost-monitoring --spawn same-dir",
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
    expect(renderUnit(cfg(), item, "n")).not.toContain("SSH_AUTH_SOCK");
  });

  test("User comes from config", () => {
    expect(renderUnit(cfg({ SERVICE_USER: "bob" }), item, "n")).toContain("\nUser=bob\n");
  });

  test("marker round-trips; non-marker is null", () => {
    expect(parseManaged(renderUnit(cfg(), item, "n"))).toEqual({ path: item });
    expect(parseManaged("[Unit]\nDescription=x\n")).toBeNull();
    expect(parseManaged("")).toBeNull();
  });

  test("hostile path is escaped", () => {
    const entry = '/srv/my "proj" 100%$x é';
    const out = renderUnit(cfg(), entry, "n");
    expect(out).toContain('WorkingDirectory=/srv/my "proj" 100%%$x é\n');
    expect(out.split("\n").filter((part) => part.startsWith("ExecStart="))).toEqual([
      "ExecStart=/root/.local/bin/claude remote-control --name n --spawn same-dir",
    ]);
    expect(parseManaged(out)).toEqual({ path: entry });
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
    expect(() => renderUnit(cfg({ CLAUDE_RC_ARGS: "--a --b\u0001c" }), item, "n")).toThrow();
    expect(() => renderUnit(cfg({ CLAUDE_BIN: "cl\naude" }), item, "n")).toThrow();
    expect(() => renderUnit(cfg({ SSH_AUTH_SOCK: "/run/a\nExecStartPre=x" }), item, "n")).toThrow();
    expect(() => renderUnit(cfg({ SERVICE_USER: "bob" + BS }), item, "n")).toThrow();
  });

  test("relative path throws", () => {
    expect(() => renderUnit(cfg(), "rel/dir", "n")).toThrow();
  });

  test("invalid name throws", () => {
    expect(() => renderUnit(cfg(), item, "a b")).toThrow();
    expect(() => renderUnit(cfg(), item, "")).toThrow();
  });

  test("claudeBin with space is double-quoted; specials escaped", () => {
    const out = renderUnit(cfg({ CLAUDE_BIN: "/opt/my claude/bin/claude" }), item, "n");
    expect(out).toContain('ExecStart="/opt/my claude/bin/claude" remote-control --name n');
    const out2 = renderUnit(cfg({ CLAUDE_BIN: String.raw`/o/a"b$c%d\e` }), item, "n");
    expect(out2).toContain(String.raw`ExecStart="/o/a\"b$$c%%d\\e" remote-control`);
  });

  test("Environment values escape quotes, backslashes and %", () => {
    const out = renderUnit(cfg({ SERVICE_HOME: String.raw`/h/a"b%c\d` }), item, "n");
    expect(out).toContain(String.raw`Environment="HOME=/h/a\"b%%c\\d"`);
  });

  test("control chars in config values throw", () => {
    expect(() => renderUnit(cfg({ SERVICE_PATH: "/a\nExecStartPre=x" }), item, "n")).toThrow();
    expect(() => renderUnit(cfg({ SERVICE_USER: "root\nUser=x" }), item, "n")).toThrow();
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
    expect(instanceId(item)).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId(item)).toBe(instanceId(item));
    expect(instanceId(item)).not.toBe(instanceId(item + "2"));
    expect(unitName("abc")).toBe("claude-rc-abc.service");
  });

  test("defaultName", () => {
    expect(defaultName(cfg({ NAME_PREFIX: "myhost-" }), item)).toBe("myhost-monitoring");
    expect(defaultName(cfg(), "/x/my proj é")).toBe("my-proj--");
    expect(defaultName(cfg(), "/")).toBe("claude");
    expect(defaultName(cfg(), "/x/" + "a".repeat(100))).toHaveLength(64);
    expect(isValidName(defaultName(cfg(), "/x/we ird$"))).toBe(true);
    // Windows paths: the last folder name, whichever separator is used.
    expect(defaultName(cfg(), "C:\\work\\myproj")).toBe("myproj");
    expect(defaultName(cfg({ NAME_PREFIX: "win-" }), "D:/work/myproj/")).toBe("win-myproj");
    expect(defaultName(cfg(), "\\\\server\\share\\proj")).toBe("proj");
    expect(defaultName(cfg(), "C:\\")).toBe("claude");
    // A backslash in a POSIX path is part of the folder name, as before.
    expect(defaultName(cfg(), "/x/a\\b")).toBe("a-b");
    expect(defaultName(cfg(), "/x/--dangerously-skip-permissions")).toBe("dangerously-skip-permissions");
    expect(defaultName(cfg(), "/x/---")).toBe("claude");
    expect(defaultName(cfg({ NAME_PREFIX: "-" }), "/x/p")).toBe("p");
  });
});

describe("flag injection and scope", () => {
  test("renderUnit rejects a name starting with '-'", () => {
    expect(() => renderUnit(cfg(), item, "--dangerously-skip-permissions")).toThrow();
    expect(() => renderUnit(cfg(), item, "-x")).toThrow();
  });

  test("system scope has User= and multi-user.target", () => {
    const out = renderUnit(cfg(), item, "n");
    expect(out).toContain("\nUser=root\n");
    expect(out).toContain("WantedBy=multi-user.target");
  });

  test("user scope: WantedBy=default.target and no User=", () => {
    const out = renderUnit(cfg({ SYSTEMD_SCOPE: "user", SERVICE_USER: "bob" }), item, "n");
    expect(out).toContain("WantedBy=default.target");
    expect(out).not.toContain("multi-user.target");
    expect(out.split("\n").some((part) => part.startsWith("User="))).toBe(false);
  });
});

describe("renderUnit run-as user", () => {
  const alice = { name: "alice", uid: 1000, gid: 1000, home: "/home/alice" };
  test("uses the user, HOME, PATH and claude binary of runAs", () => {
    const out = renderUnit(cfg(), item, "n", runAsFor(cfg(), alice));
    expect(out).toContain("\nUser=alice\n");
    expect(out).toContain('Environment="HOME=/home/alice"');
    expect(out).toContain(
      'Environment="PATH=/home/alice/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    );
    expect(out).toContain("\nExecStart=/home/alice/.local/bin/claude remote-control");
  });
  test("rejects a user name with a space, newline or equals sign", () => {
    for (const bad of ["a b", "a\nb", "a=b"]) {
      const ra = { user: bad, home: "/home/x", path: "/bin", claudeBin: "/home/x/.local/bin/claude" };
      expect(() => renderUnit(cfg(), item, "n", ra)).toThrow();
      expect(() => runAsFor(cfg(), { ...alice, name: bad })).toThrow();
    }
  });
  test("omits User= in user scope for any runAs", () => {
    const out = renderUnit(cfg({ SYSTEMD_SCOPE: "user" }), item, "n", runAsFor(cfg(), alice));
    expect(out).not.toContain("User=");
  });
});

describe("parseUnitUser", () => {
  test("returns the name, or null when there is no User= line", () => {
    expect(parseUnitUser("[Service]\nUser=alice\nType=simple\n")).toBe("alice");
    expect(parseUnitUser("[Service]\nType=simple\n")).toBeNull();
  });
});

describe("unit settings", () => {
  test("round trip keeps settings with spaces and a percent sign in the binary path", () => {
    const config = cfg({ CLAUDE_RC_ARGS: "--verbose" });
    config.claudeBin = "/opt/my bin/100%/claude";
    const out = renderUnit(config, item, "my-proj", undefined, { createSession: false, spawnMode: "worktree" });
    expect(out).toContain(
      '"/opt/my bin/100%%/claude" remote-control --name my-proj --verbose --spawn worktree --no-create-session-in-dir',
    );
    expect(parseUnitSettings(out)).toEqual({ createSession: false, spawnMode: "worktree" });
  });
  test("operator args with quotes and backslashes survive", () => {
    const config = cfg();
    config.claudeRcArgs = ["--note", 'a "b" c\\d $x', "--spawn", "worktree"];
    const out = renderUnit(config, item, "n", undefined, { createSession: false, spawnMode: "worktree" });
    expect(parseUnitSettings(out)).toEqual({ createSession: false, spawnMode: "worktree" });
    expect(out).toContain('--note "a \\"b\\" c\\\\d $$x" --spawn worktree');
  });
  test("execWords undoes the execWord quoting", () => {
    const config = cfg();
    config.claudeBin = "/opt/my bin/100%/claude";
    config.claudeRcArgs = ["", "--note", 'a "b" c\\d $x %h', "$$", "%%", "plain", "--spawn", "worktree"];
    const out = renderUnit(config, item, "n");
    const value = defined(/^ExecStart=(.*)$/m.exec(out))[1];
    expect(execWords(value)).toEqual([config.claudeBin, "remote-control", "--name", "n", ...config.claudeRcArgs]);
  });
  test("old unit with flags reads back", () => {
    const entry = "ExecStart=/bin/claude remote-control --name x --spawn same-dir --no-create-session-in-dir\n";
    expect(parseUnitSettings(entry)).toEqual({ createSession: false, spawnMode: "same-dir" });
  });
  test("a unit with no flags reads as the defaults", () => {
    expect(parseUnitSettings("ExecStart=/bin/claude remote-control --name x\n")).toEqual({
      createSession: true,
      spawnMode: "same-dir",
    });
    expect(parseUnitSettings("")).toEqual({ createSession: true, spawnMode: "same-dir" });
  });
  test("settings keep other operator flags", () => {
    const config = cfg();
    config.claudeRcArgs = ["--spawn", "worktree", "--permission-mode", "plan"];
    const out = renderUnit(config, item, "n", undefined, { createSession: true, spawnMode: "same-dir" });
    expect(out).toContain("--name n --permission-mode plan --spawn same-dir\n");
  });
  test("without settings the args are untouched", () => {
    const config = cfg();
    config.claudeRcArgs = ["--no-create-session-in-dir", "--x"];
    expect(renderUnit(config, item, "n")).toContain("--name n --no-create-session-in-dir --x\n");
  });
});
