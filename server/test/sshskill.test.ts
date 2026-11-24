import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/runner";
import { bunRunner } from "../src/runner";
import { SSH_SKILL, ensureSkill, renderSkill, skillVersion } from "../src/sshskill";
import type { SkillUser } from "../src/sshskill";
import { defined } from "./support";

// Every test uses a temporary folder as the home. No test reaches a real home.

let root: string;
let home: string;
let logged: string[];
const notRoot = () => false;
const noRun: Runner = () => Promise.reject(new Error("the runner must not be called"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-skill-"));
  home = join(root, "home");
  mkdirSync(home);
  logged = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const skillFile = () => join(home, ".claude", "skills", "ssh-access", "SKILL.md");
const log = (line: string) => void logged.push(line);
/** A user that the node IS (no uid, no gid): the direct path. */
const self = (): SkillUser => ({ name: "me", home, path: "/usr/bin" });

describe("the text of the skill", () => {
  test("it has the frontmatter, the managed line with the hash of the rest, and the title", () => {
    expect(SSH_SKILL.startsWith("---\nname: ssh-access\ndescription: ")).toBe(true);
    const lines = SSH_SKILL.split("\n");
    const index = lines.findIndex((line) => line.startsWith("<!-- managed by claude-rc-launcher sha256:"));
    expect(index).toBeGreaterThan(3);
    const match = /^<!-- managed by claude-rc-launcher sha256:([0-9a-f]{64}) -->$/.exec(lines[index] ?? "");
    const rest = lines.filter((_line, at) => at !== index).join("\n");
    expect(match?.[1]).toBe(createHash("sha256").update(rest).digest("hex"));
    expect(SSH_SKILL).toContain("# SSH access to other machines");
    expect(SSH_SKILL).toContain("claude-rc ssh targets");
    expect(SSH_SKILL).toContain("SSH access is not turned on for this instance");
    expect(SSH_SKILL).toContain("run_in_background");
  });

  test("a different body gives a different hash and a different version", () => {
    expect(renderSkill(undefined, "other\n")).not.toBe(SSH_SKILL);
    expect(skillVersion("a")).not.toBe(skillVersion("b"));
  });
});

describe("the node is the user (direct path)", () => {
  test("it writes the file with mode 644 and the right content", async () => {
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("written");
    expect(readFileSync(skillFile(), "utf8")).toBe(SSH_SKILL);
    expect(statSync(skillFile()).mode & 0o777).toBe(0o644);
    // No temporary file stays behind.
    expect(readdirSync(join(home, ".claude", "skills", "ssh-access"))).toEqual(["SKILL.md"]);
  });

  test("a second run is unchanged and does not write", async () => {
    await ensureSkill(self(), { run: noRun, isRoot: notRoot, log });
    const before = statSync(skillFile());
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("unchanged");
    const after = statSync(skillFile());
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("a new version of the skill rewrites the file", async () => {
    await ensureSkill(self(), { run: noRun, isRoot: notRoot, log });
    const next = renderSkill(undefined, "# SSH access to other machines\n\nnew text\n");
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log, content: next })).toBe("written");
    expect(readFileSync(skillFile(), "utf8")).toBe(next);
  });

  test("a managed file that somebody edited is kept, and one line says so once", async () => {
    await ensureSkill(self(), { run: noRun, isRoot: notRoot, log });
    const edited = readFileSync(skillFile(), "utf8") + "extra\n";
    writeFileSync(skillFile(), edited);
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe(edited);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("was edited, left as it is; delete it to get the new version");
  });

  test("a tampered body under an old marker line is kept", async () => {
    const old = renderSkill(undefined, "# SSH access to other machines\n\nold text\n");
    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    writeFileSync(skillFile(), old.replace("old text", "evil text"));
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toContain("evil text");
  });

  test("an unedited old version is updated", async () => {
    const old = renderSkill(undefined, "# SSH access to other machines\n\nold text\n");
    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    writeFileSync(skillFile(), old);
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("written");
    expect(readFileSync(skillFile(), "utf8")).toBe(SSH_SKILL);
  });

  test("a foreign file that quotes the managed line in its body is never touched", async () => {
    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    const quoted = `---\nname: ssh-access\n---\nmy notes\n${SSH_SKILL.split("\n").find((line) => line.startsWith("<!--")) ?? ""}\n`;
    writeFileSync(skillFile(), quoted);
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe(quoted);
    expect(logged[0]).toContain("not managed by the launcher");
  });

  test("a marker with a wrong hash right after the frontmatter is kept", async () => {
    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    const wrong = `---\nname: ssh-access\n---\n<!-- managed by claude-rc-launcher sha256:${"0".repeat(64)} -->\nbody\n`;
    writeFileSync(skillFile(), wrong);
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe(wrong);
  });

  test("a root node with no user to switch to refuses to write by path", async () => {
    expect(await ensureSkill(self(), { run: noRun, isRoot: () => true, log })).toBe("failed");
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(logged[0]).toContain("runs as root");
  });

  test("a home that is not an absolute path is refused", async () => {
    const relative: SkillUser = { name: "rel", home: "relative/home", path: "/usr/bin" };
    expect(await ensureSkill(relative, { run: noRun, isRoot: notRoot, log })).toBe("failed");
    expect(logged[0]).toContain("not an absolute path");
    expect(await ensureSkill({ ...relative, uid: 1, gid: 1 }, { run: noRun, log })).toBe("failed");
  });

  test("a file without the managed line is left alone, and one line is logged once", async () => {
    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    writeFileSync(skillFile(), "---\nname: ssh-access\n---\nmy own text\n");
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe("---\nname: ssh-access\n---\nmy own text\n");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("me");
  });

  for (const part of [".claude", ".claude/skills", ".claude/skills/ssh-access", ".claude/skills/ssh-access/SKILL.md"]) {
    test(`a symbolic link at ${part} is refused and the target stays as it was`, async () => {
      const victim = join(root, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "keep"), "keep");
      const full = join(home, part);
      const parts = part.split("/");
      // Make the folders above the link, then the link itself.
      let current = home;

      for (const name of parts.slice(0, -1)) {
        current = join(current, name);
        mkdirSync(current);
      }

      if (part.endsWith("SKILL.md")) writeFileSync(join(victim, "SKILL.md"), "target");
      symlinkSync(part.endsWith("SKILL.md") ? join(victim, "SKILL.md") : victim, full);

      expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("failed");
      expect(logged.join("\n")).toContain("symbolic link");
      expect(lstatSync(full).isSymbolicLink()).toBe(true);
      expect(readdirSync(victim).sort()).toEqual(part.endsWith("SKILL.md") ? ["SKILL.md", "keep"] : ["keep"]);
      if (part.endsWith("SKILL.md")) expect(readFileSync(join(victim, "SKILL.md"), "utf8")).toBe("target");
    });
  }

  test("a failure never throws: it returns failed and logs one line with the user name", async () => {
    writeFileSync(join(home, ".claude"), "a file where a folder should be");
    expect(await ensureSkill(self(), { run: noRun, isRoot: notRoot, log })).toBe("failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("me");
    expect(existsSync(skillFile())).toBe(false);
  });
});

describe("the node switches to the user (root path)", () => {
  const rootUser = (): SkillUser => ({ name: "alice", home, path: "/usr/bin", uid: 1000, gid: 1001 });

  test("the runner gets setpriv, the home in the environment and the content on stdin, never in the command", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string>; stdin?: string }[] = [];

    const run: Runner = (cmd, args, opts) => {
      calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}), ...(opts?.stdin ? { stdin: opts.stdin } : {}) });
      return Promise.resolve({ code: 0, stdout: args.at(-1) === "read" ? "absent\n" : "written\n", stderr: "" });
    };

    expect(await ensureSkill(rootUser(), { run, log })).toBe("written");
    expect(calls.map((item) => item.args.at(-1))).toEqual(["read", "write"]);
    const call = defined(calls[1]);
    expect(call.cmd).toMatch(/^\/.*\/setpriv$/);
    expect(call.env?.PATH).toBe("/usr/bin:/bin");
    expect(call.args.slice(0, 6)).toEqual(["--reuid", "1000", "--regid", "1001", "--init-groups", "--"]);
    expect(call.stdin).toBe(SSH_SKILL);
    expect(call.env?.HOME).toBe(home);
    const commandLine = [call.cmd, ...call.args].join("\n");
    expect(commandLine).not.toContain(home);
    expect(commandLine).not.toContain("SSH access to other machines");
    expect(commandLine).not.toContain("claude-rc ssh targets");
  });

  test("a failing command is failed, with the first line of its error", async () => {
    const run: Runner = () => Promise.resolve({ code: 3, stdout: "", stderr: "refused: x is a symbolic link\nmore" });
    expect(await ensureSkill(rootUser(), { run, log })).toBe("failed");
    expect(logged).toEqual([
      "ssh skill for alice: cannot install: refused: x is a symbolic link; will retry at the next instance change",
    ]);
  });

  test("a runner that throws is failed", async () => {
    expect(await ensureSkill(rootUser(), { run: noRun, isRoot: notRoot, log })).toBe("failed");
    expect(logged[0]).toContain("alice");
  });

  /** Runs the real script of the root path, without the switch of the user, in the fake home. */
  const realScript: Runner = (cmd, args, opts) => {
    expect(cmd).toMatch(/\/setpriv$/);
    const at = args.indexOf("--");
    return bunRunner(args[at + 1] ?? "", args.slice(at + 2), {
      ...opts,
      env: { ...opts?.env, PATH: process.env.PATH ?? "" },
    });
  };

  test("the script writes, keeps, updates and refuses links as it should", async () => {
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("written");
    expect(readFileSync(skillFile(), "utf8")).toBe(SSH_SKILL);
    expect(statSync(skillFile()).mode & 0o777).toBe(0o644);
    const first = statSync(skillFile());
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("unchanged");
    expect(statSync(skillFile()).ino).toBe(first.ino);

    const next = renderSkill(undefined, "new text\n");
    expect(await ensureSkill(rootUser(), { run: realScript, log, content: next })).toBe("written");
    expect(readFileSync(skillFile(), "utf8")).toBe(next);
    expect(readdirSync(join(home, ".claude", "skills", "ssh-access"))).toEqual(["SKILL.md"]);

    writeFileSync(skillFile(), "mine\n");
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe("mine\n");
  });

  test("through the script, an edited managed file and a file that quotes the marker are kept, an old one is updated", async () => {
    const old = renderSkill(undefined, "# SSH access to other machines\n\nold text\n");
    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    writeFileSync(skillFile(), old);
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("written");
    expect(readFileSync(skillFile(), "utf8")).toBe(SSH_SKILL);

    const edited = SSH_SKILL + "extra\n";
    writeFileSync(skillFile(), edited);
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe(edited);

    const quoted = `---\nname: ssh-access\n---\nnotes\n${SSH_SKILL.split("\n").find((line) => line.startsWith("<!--")) ?? ""}\n`;
    writeFileSync(skillFile(), quoted);
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("kept-foreign");
    expect(readFileSync(skillFile(), "utf8")).toBe(quoted);
  });

  test("the script refuses a link at the folder and at the file", async () => {
    const victim = join(root, "victim");
    mkdirSync(victim);
    mkdirSync(join(home, ".claude"));
    symlinkSync(victim, join(home, ".claude", "skills"));
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("failed");
    expect(readdirSync(victim)).toEqual([]);
    rmSync(join(home, ".claude", "skills"));

    mkdirSync(join(home, ".claude", "skills", "ssh-access"), { recursive: true });
    writeFileSync(join(victim, "target"), "t");
    symlinkSync(join(victim, "target"), skillFile());
    expect(await ensureSkill(rootUser(), { run: realScript, log })).toBe("failed");
    expect(readFileSync(join(victim, "target"), "utf8")).toBe("t");
  });
});

describe("Windows", () => {
  test("it does nothing and does not call the runner", async () => {
    const result = await ensureSkill(
      { name: "w", home, path: "" },
      { run: noRun, isRoot: notRoot, log, platform: "win32" },
    );
    expect(result).toBe("unchanged");
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(logged).toEqual([]);
  });
});
