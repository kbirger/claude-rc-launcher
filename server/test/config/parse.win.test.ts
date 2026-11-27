import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath } from "../../src/config/file";
import { ConfigError, parseConfig, windowsDataDir } from "../../src/config/parse";
import type { ConfigIo } from "../../src/config/parse";
import { accountName, checkServiceAccount } from "../../src/win/account";
import { defined } from "../support";

const io: ConfigIo = { readFile: () => "x".repeat(40) };
const node = (extra: Record<string, unknown> = {}) => ({
  mode: "node",
  tls: { names: ["win.example.com"] },
  node_auth: { secret: [{ sha256: "a".repeat(64) }] },
  ...extra,
});
const win = (raw: unknown) => parseConfig(raw, io, { windows: true });

const winProblems = (raw: unknown): string => {
  try {
    win(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }

  throw new Error("no throw");
};

describe("Windows node config", () => {
  test("defaults come from the running account and ProgramData", () => {
    const config = win(node());
    expect(config.mode).toBe("node");
    expect(config.serviceUser).toBe(os.userInfo().username);
    expect(config.serviceHome).toBe(os.homedir());
    expect(config.roots).toEqual([os.homedir()]);
    // Built with Windows path rules whatever the host is: a Linux host has a different home folder.
    expect(config.claudeBin).toBe(path.win32.join(config.serviceHome, ".local", "bin", "claude.exe"));
    expect(config.claudeBin.toLowerCase()).toEndWith("\\.local\\bin\\claude.exe");
    expect(config.claudeRcArgs).toEqual(["--spawn", "same-dir"]);
    expect(defined(config.node).tls.stateDir).toBe(windowsDataDir());
    expect(config.unitDir).toBe("");
    expect(config.servicePath).toBe("");
    expect(config.sshAuthSock).toBeUndefined();
  });

  test("the mode may be left out, and a hub is refused", () => {
    const { mode: _m, ...noMode } = node();
    expect(win(noMode).mode).toBe("node");
    expect(winProblems({ ...node(), mode: "hub" })).toContain("a Windows machine runs as a node only");
  });

  test("service_user, service_home, roots, claude_bin and Windows paths are honored", () => {
    const config = win(
      node({
        instance: {
          service_user: "svc",
          service_home: "D:\\Users\\svc",
          roots: ["D:\\work", "E:\\src"],
          claude_bin: "D:\\tools\\claude.exe",
          name_prefix: "win-",
        },
        tls: { names: ["h"], state_dir: "D:\\data\\rc" },
      }),
    );
    expect(config.serviceUser).toBe("svc");
    expect(config.serviceHome).toBe("D:\\Users\\svc");
    expect(config.roots).toEqual(["D:\\work", "E:\\src"]);
    expect(config.claudeBin).toBe("D:\\tools\\claude.exe");
    expect(config.namePrefix).toBe("win-");
    expect(defined(config.node).tls.stateDir).toBe("D:\\data\\rc");
  });

  test("a relative path is refused", () => {
    expect(winProblems(node({ instance: { roots: ["work"] } }))).toContain("roots");
  });

  test("the systemd-only keys are errors, each named", () => {
    const msg = winProblems(
      node({
        instance: { scope: "user", unit_dir: "/etc/systemd/system", service_path: "/usr/bin", ssh_auth_sock: "/run/x" },
      }),
    );
    for (const key of ["scope", "unit_dir", "service_path", "ssh_auth_sock"])
      expect(msg).toContain(`instance.${key} is not supported on Windows`);
    expect(msg).not.toContain("unknown key");
  });

  test("an unknown instance key is still an error", () => {
    expect(winProblems(node({ instance: { nope: 1 } }))).toContain("unknown key instance.nope");
  });

  test("the same file without the windows option keeps the Linux behavior", () => {
    const config = parseConfig(node({ instance: { scope: "user", service_user: "alice" } }), io);
    expect(config.scope).toBe("user");
    expect(config.serviceHome).toBe("/home/alice");
    expect(config.unitDir).toBe("/home/alice/.config/systemd/user");
    expect(defined(config.node).tls.stateDir).toBe("/var/lib/claude-rc-launcher");
  });
});

describe("resolveConfigPath", () => {
  test("a default path can be given", () => {
    expect(resolveConfigPath([], {}, "C:\\ProgramData\\x\\config.toml")).toBe("C:\\ProgramData\\x\\config.toml");
    expect(resolveConfigPath([], { CLAUDE_RC_CONFIG: "E:\\c.toml" }, "C:\\d.toml")).toBe("E:\\c.toml");
    expect(resolveConfigPath(["--config", "F:\\c.toml"], {}, "C:\\d.toml")).toBe("F:\\c.toml");
    expect(resolveConfigPath([], {})).toBe("/etc/claude-rc-launcher/config.toml");
  });
});

describe("service account check", () => {
  test("names compare without domain and without case", () => {
    expect(accountName("KIRSTATION4\\Kir")).toBe("kir");
    expect(accountName(".\\kir")).toBe("kir");
    expect(accountName("kir")).toBe("kir");
  });

  test("the same account passes", () => {
    expect(() => {
      checkServiceAccount("kir", "KIR");
    }).not.toThrow();
    expect(() => {
      checkServiceAccount("PC\\kir", "kir");
    }).not.toThrow();
  });

  test("a different account fails with both names in the message", () => {
    expect(() => {
      checkServiceAccount("svc", "kir");
    }).toThrow(/"svc".*"kir"/);
  });
});
