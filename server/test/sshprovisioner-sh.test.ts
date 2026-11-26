import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionScript } from "../src/sshprovision";
import { linuxInstallScript, linuxScript, provisionerLine } from "../src/sshprovisioner";
import vectors from "../src/sshprovisioner.vectors.json";
import { authorizedKeysLine } from "../src/sshtargets";

const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGmainmainmainmainmainmainmainmainmainmain";
const PBLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGprovprovprovprovprovprovprovprovprovprov";
const MAIN = `ssh-ed25519 ${BLOB} claude-rc:nas`;
const PROV = `ssh-ed25519 ${PBLOB} claude-rc-provisioner:nas`;
const LOCAL = "192.168.1.103";
const OWNER = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB owner@laptop";
const CRLF_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIother crlf@box";

// Absolute paths, so that a test can run the script with a short PATH.
const SHELLS: { name: string; argv: string[] }[] = [{ name: "sh", argv: [Bun.which("sh") ?? "/bin/sh"] }];
const dashPath = Bun.which("dash");
if (dashPath) SHELLS.push({ name: "dash", argv: [dashPath] });
const busyboxPath = Bun.which("busybox");
if (busyboxPath) SHELLS.push({ name: "busybox sh", argv: [busyboxPath, "sh"] });

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Box {
  home: string;
  keys: string;
  state: string;
  script: string;
  run: (command: string | undefined, path?: string) => Promise<{ code: number; out: string; err: string }>;
  read: () => Promise<string>;
}

function provLineOf(text: string): string {
  const found = text.split("\n").find((line) => line.endsWith("claude-rc-provisioner:nas"));
  if (found === undefined) throw new Error("no provisioner line");
  return found;
}

const gone = (path: string) =>
  lstat(path).then(
    () => false,
    () => true,
  );
const mode = async (path: string) => (await stat(path)).mode & 0o777;

async function spawnShell(
  argv: string[],
  args: string[],
  home: string,
  stdin?: string,
  command?: string | null,
  path?: string,
) {
  const env: Record<string, string> = { PATH: path ?? process.env.PATH ?? "", HOME: home };
  if (command !== undefined && command !== null) env.SSH_ORIGINAL_COMMAND = command;
  const proc = Bun.spawn([...argv, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** A temporary home with the main line (written by the provision script of today) and the provisioner installed. */
async function box(
  shell: string[],
  options: { initial?: string; main?: boolean; sources?: string[] } = {},
): Promise<Box> {
  const home = await mkdtemp(join(tmpdir(), "provsh-"));
  made.push(home);
  const sources = options.sources ?? ["10.0.0.1"];
  const keys = join(home, ".ssh", "authorized_keys");
  await mkdir(join(home, ".ssh"), { mode: 0o700 });
  await writeFile(keys, options.initial ?? `${OWNER}\n# a comment line\n${CRLF_LINE}\r\n`, { mode: 0o600 });

  if (options.main !== false) {
    const main = await spawnShell(
      shell,
      ["-s"],
      home,
      provisionScript("linux", authorizedKeysLine(MAIN, sources)).script,
    );
    expect(main.code).toBe(0);
  }

  const install = linuxInstallScript({
    targetId: "nas",
    mainPublicLine: MAIN,
    provisionerPublicLine: PROV,
    localSource: LOCAL,
    sources,
  });
  const done = await spawnShell(shell, ["-s"], home, install.script);
  expect(done.err).toBe("");
  const script = join(home, ".claude-rc", "provisioner-nas.sh");
  expect(done.out).toBe(`ok installed ${script}\n`);
  expect(done.code).toBe(0);
  return {
    home,
    keys,
    state: join(home, ".claude-rc", "provisioner-nas.from"),
    script,
    run: (command, path) => spawnShell(shell, [script], home, undefined, command, path),
    read: () => readFile(keys, "utf8"),
  };
}

const lineCount = (text: string, needle: string) =>
  text.split("\n").filter((line) => line.replace(/\r$/, "").endsWith(needle)).length;
const provCount = (text: string) => lineCount(text, `${PBLOB} claude-rc-provisioner:nas`);
const mainCount = (text: string) => lineCount(text, `${BLOB} claude-rc:nas`);

for (const shell of SHELLS) {
  describe(`provisioner script under ${shell.name}`, () => {
    test("refuses every reject vector with exit 2 and changes no byte of the key file", async () => {
      const bx = await box(shell.argv);
      const before = await readFile(bx.keys);
      const stateBefore = await readFile(bx.state);

      for (const text of vectors.reject) {
        if (text.includes("\u0000")) continue;
        const result = await bx.run(text);
        expect(result.code, JSON.stringify(text.slice(0, 40))).toBe(2);
        expect(result.out).toBe("");
        expect(result.err).toMatch(/^error bad-command /);
      }

      expect((await bx.run(undefined)).code).toBe(2);
      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
      expect(Buffer.compare(await readFile(bx.state), stateBefore)).toBe(0);
    });

    test("takes every accept vector that needs no state change", async () => {
      const bx = await box(shell.argv);

      for (const text of vectors.accept.filter((item) => item.startsWith("sources ") && item.length < 400)) {
        const result = await bx.run(text);
        expect(result.code, text).toBe(0);
        expect(result.out).toBe(`ok ${text}\n`);
      }

      expect(provCount(await bx.read())).toBe(1);
    });

    test("takes the largest accepted list", async () => {
      const bx = await box(shell.argv);

      for (const text of vectors.accept.filter((item) => item.startsWith("sources ") && item.length >= 400)) {
        expect((await bx.run(text)).code, text.slice(0, 30)).toBe(0);
      }
    });

    test("on adds the main line once", async () => {
      const bx = await box(shell.argv, { main: false });
      expect(mainCount(await bx.read())).toBe(0);
      const result = await bx.run("on");
      expect(result).toEqual({ code: 0, out: "ok on 10.0.0.1\n", err: "" });
      const text = await bx.read();
      expect(mainCount(text)).toBe(1);
      expect(text).toContain(`\nfrom="10.0.0.1",restrict ${MAIN}\n`);
      expect(provCount(text)).toBe(1);
    });

    test("on twice changes nothing", async () => {
      const bx = await box(shell.argv, { main: false });
      await bx.run("on");
      const before = await readFile(bx.keys);
      const mtime = (await stat(bx.keys)).mtimeMs;
      expect((await bx.run("on")).code).toBe(0);
      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
      expect((await stat(bx.keys)).mtimeMs).toBe(mtime);
    });

    test("on replaces an older line of the same key with another from list", async () => {
      const bx = await box(shell.argv, { main: false });
      await writeFile(bx.keys, `${await bx.read()}from="9.9.9.9",restrict ${MAIN}\n`);
      expect((await bx.run("on")).code).toBe(0);
      const text = await bx.read();
      expect(mainCount(text)).toBe(1);
      expect(text).toContain(`from="10.0.0.1",restrict ${MAIN}`);
      expect(text).not.toContain("9.9.9.9");
    });

    test("off removes only the main line", async () => {
      const bx = await box(shell.argv);
      const before = await bx.read();
      expect(await bx.run("off")).toEqual({ code: 0, out: "ok off\n", err: "" });
      const expected = before
        .split("\n")
        .filter((line) => !line.endsWith(`${BLOB} claude-rc:nas`))
        .join("\n");
      expect(await bx.read()).toBe(expected);
      expect(await readFile(bx.state, "utf8")).toBe("10.0.0.1\n");
      expect((await bx.run("off")).code).toBe(0);
      expect(await bx.read()).toBe(expected);
    });

    test("sources rewrites from of a present line", async () => {
      const bx = await box(shell.argv);
      const result = await bx.run("sources 10.0.0.2,host.example");
      expect(result).toEqual({ code: 0, out: "ok sources 10.0.0.2,host.example\n", err: "" });
      const text = await bx.read();
      expect(mainCount(text)).toBe(1);
      expect(text).toContain(`\nfrom="10.0.0.2,host.example",restrict ${MAIN}\n`);
      expect(text).not.toContain('from="10.0.0.1"');
      expect(provCount(text)).toBe(1);
      expect(await readFile(bx.state, "utf8")).toBe("10.0.0.2,host.example\n");
      expect((await bx.run("status")).out).toBe("ok status present 10.0.0.2,host.example\n");
    });

    test("sources on an absent line only writes the state file", async () => {
      const bx = await box(shell.argv, { main: false });
      const before = await readFile(bx.keys);
      expect(await bx.run("sources 10.0.0.9")).toEqual({ code: 0, out: "ok sources 10.0.0.9\n", err: "" });
      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
      expect(await readFile(bx.state, "utf8")).toBe("10.0.0.9\n");
      expect((await bx.run("on")).out).toBe("ok on 10.0.0.9\n");
    });

    test("status reports present and absent with the list", async () => {
      const bx = await box(shell.argv);
      const before = await readFile(bx.keys);
      expect(await bx.run("status")).toEqual({ code: 0, out: "ok status present 10.0.0.1\n", err: "" });
      await bx.run("off");
      expect((await bx.run("status")).out).toBe("ok status absent 10.0.0.1\n");
      expect(await bx.run("on")).toMatchObject({ code: 0 });
      // the main line moves to the end, so compare the lines
      expect((await bx.read()).split("\n").sort()).toEqual(before.toString().split("\n").sort());
    });

    test("status reports present for a line that the provision script of today wrote", async () => {
      const bx = await box(shell.argv, { sources: ["192.168.1.103", "192.168.1.50"] });
      expect((await bx.run("status")).out).toBe("ok status present 192.168.1.103,192.168.1.50\n");
    });

    test("status changes no byte", async () => {
      const bx = await box(shell.argv);
      const before = await readFile(bx.keys);
      const mtime = (await stat(bx.keys)).mtimeMs;
      await bx.run("status");
      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
      expect((await stat(bx.keys)).mtimeMs).toBe(mtime);
    });

    test("uninstall removes both lines, the state file and the script", async () => {
      const bx = await box(shell.argv);
      const result = await bx.run("uninstall");
      expect(result).toEqual({ code: 0, out: "ok uninstall\n", err: "" });
      expect(await bx.read()).toBe(`${OWNER}\n# a comment line\n${CRLF_LINE}\r\n`);
      expect(await gone(bx.state)).toBe(true);
      expect(await gone(bx.script)).toBe(true);
    });

    test("keeps other lines with their bytes", async () => {
      const bx = await box(shell.argv);
      const before = await bx.read();
      const others = before
        .split("\n")
        .filter((line) => !line.includes("claude-rc"))
        .join("\n");
      await bx.run("off");
      const afterOff = await bx.read();
      expect(afterOff).toContain(`${OWNER}\n# a comment line\n${CRLF_LINE}\r\n`);
      expect(mainCount(afterOff)).toBe(0);
      await bx.run("on");
      await bx.run("sources 10.0.0.2");
      await bx.run("uninstall");
      expect(await bx.read()).toBe(others);
    });

    test("a last line without a newline stays without it after off and uninstall", async () => {
      const bx = await box(shell.argv);
      // main and provisioner lines first, then a hand-written line without a newline at the end
      await writeFile(bx.keys, `${await bx.read()}last line without newline`);
      await bx.run("off");
      expect((await bx.read()).endsWith("\nlast line without newline")).toBe(true);
      expect(provCount(await bx.read())).toBe(1);
      await bx.run("uninstall");
      expect((await bx.read()).endsWith("\nlast line without newline")).toBe(true);
      expect((await bx.read()).includes("claude-rc")).toBe(false);
    });

    test("refuses a symbolic link at .ssh, at the key file and at the state file with exit 3", async () => {
      // the key file
      let bx = await box(shell.argv);
      await rename(bx.keys, `${bx.keys}.real`);
      await symlink(`${bx.keys}.real`, bx.keys);
      const realBefore = await readFile(`${bx.keys}.real`);
      for (const command of ["on", "off", "status", "sources 10.0.0.2", "uninstall"])
        expect((await bx.run(command)).code, `key file ${command}`).toBe(3);
      expect(Buffer.compare(await readFile(`${bx.keys}.real`), realBefore)).toBe(0);
      expect((await lstat(bx.keys)).isSymbolicLink()).toBe(true);
      // the folder
      bx = await box(shell.argv);
      await rename(join(bx.home, ".ssh"), join(bx.home, "real-ssh"));
      await symlink(join(bx.home, "real-ssh"), join(bx.home, ".ssh"));
      const folderBefore = await readFile(join(bx.home, "real-ssh", "authorized_keys"));
      for (const command of ["on", "off", "status", "sources 10.0.0.2", "uninstall"])
        expect((await bx.run(command)).code, `folder ${command}`).toBe(3);
      expect(Buffer.compare(await readFile(join(bx.home, "real-ssh", "authorized_keys")), folderBefore)).toBe(0);
      // the state file
      bx = await box(shell.argv);
      await rename(bx.state, `${bx.state}.real`);
      await symlink(`${bx.state}.real`, bx.state);
      const keysBefore = await readFile(bx.keys);
      for (const command of ["on", "off", "status", "sources 10.0.0.2", "uninstall"])
        expect((await bx.run(command)).code, `state file ${command}`).toBe(3);
      expect(Buffer.compare(await readFile(bx.keys), keysBefore)).toBe(0);
      expect(await readFile(`${bx.state}.real`, "utf8")).toBe("10.0.0.1\n");
      // the script folder
      bx = await box(shell.argv);
      const moved = join(bx.home, "real-claude-rc");
      await rename(join(bx.home, ".claude-rc"), moved);
      await symlink(moved, join(bx.home, ".claude-rc"));
      expect((await bx.run("status")).code).toBe(3);
    });

    test("the guard stops a bad edit with exit 4", async () => {
      const bx = await box(shell.argv);
      await writeFile(
        bx.script,
        linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: PBLOB, guardTest: true }),
      );
      await chmod(bx.script, 0o700);
      const before = await readFile(bx.keys);
      const stateBefore = await readFile(bx.state);

      for (const command of ["off", "sources 10.0.0.7"]) {
        const result = await bx.run(command);
        expect(result.code, command).toBe(4);
        expect(result.err).toMatch(/^error guard /);
        expect(Buffer.compare(await readFile(bx.keys), before), command).toBe(0);
        expect(Buffer.compare(await readFile(bx.state), stateBefore), command).toBe(0);
      }

      await bx.run("off");
      expect(await bx.read()).toBe(before.toString());
      // `on` on an absent line is stopped too
      const plain = await box(shell.argv, { main: false });
      await writeFile(
        plain.script,
        linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: PBLOB, guardTest: true }),
      );
      await chmod(plain.script, 0o700);
      const plainBefore = await readFile(plain.keys);
      expect((await plain.run("on")).code).toBe(4);
      expect(Buffer.compare(await readFile(plain.keys), plainBefore)).toBe(0);
      expect(provCount(await plain.read())).toBe(1);
    });

    test("leaves no temporary file behind after a refused edit", async () => {
      const bx = await box(shell.argv);
      await writeFile(
        bx.script,
        linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: PBLOB, guardTest: true }),
      );
      await bx.run("off");
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(join(bx.home, ".ssh"))).sort()).toEqual(
        [".claude-rc.lock", "authorized_keys"]
          .filter((name) => name !== ".claude-rc.lock" || Bun.which("flock"))
          .sort(),
      );
    });

    test("never removes the provisioner line except on uninstall", async () => {
      const bx = await box(shell.argv);
      const commands = [
        "on",
        "off",
        "off",
        "status",
        "on",
        "on",
        "sources 10.0.0.5",
        "status",
        "off",
        "sources 10.0.0.6,10.0.0.7",
        "on",
        "bad",
        "",
        "sources *",
        "sources 1.2.3.0/24",
        "on ",
        "ON",
        "status\n",
      ];

      for (const command of commands) {
        await bx.run(command);
        expect(provCount(await bx.read()), JSON.stringify(command)).toBe(1);
      }

      await bx.run("uninstall");
      expect(provCount(await bx.read())).toBe(0);
    });

    test("on without a state list fails with exit 5", async () => {
      const bx = await box(shell.argv, { main: false });
      await rm(bx.state);
      const before = await readFile(bx.keys);
      const result = await bx.run("on");
      expect(result.code).toBe(5);
      expect(result.err).toMatch(/^error no-sources /);
      await writeFile(bx.state, "a*\n");
      expect((await bx.run("on")).code).toBe(5);
      await writeFile(bx.state, "\n");
      expect((await bx.run("on")).code).toBe(5);
      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
    });

    test("files have mode 600, the script and its folder mode 700", async () => {
      const bx = await box(shell.argv, { main: false });
      for (const command of ["on", "sources 10.0.0.2", "off", "on"]) await bx.run(command);
      expect(await mode(bx.keys)).toBe(0o600);
      expect(await mode(bx.state)).toBe(0o600);
      expect(await mode(bx.script)).toBe(0o700);
      expect(await mode(join(bx.home, ".claude-rc"))).toBe(0o700);
      expect(await mode(join(bx.home, ".ssh"))).toBe(0o700);
    });

    test("the installed script runs directly through its shebang", async () => {
      const bx = await box(shell.argv);
      const proc = Bun.spawn([bx.script], {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: bx.home, SSH_ORIGINAL_COMMAND: "status" },
      });
      expect(await new Response(proc.stdout).text()).toBe("ok status present 10.0.0.1\n");
      expect(await proc.exited).toBe(0);
    });

    test("the install writes the provisioner line with from, restrict and command, and runs twice without a second line", async () => {
      const bx = await box(shell.argv);
      const text = await bx.read();
      expect(text).toContain(`\nfrom="${LOCAL}",restrict,command="${bx.script}" ${PROV}\n`);
      const again = linuxInstallScript({
        targetId: "nas",
        mainPublicLine: MAIN,
        provisionerPublicLine: PROV,
        localSource: LOCAL,
        sources: ["10.0.0.1"],
      });
      expect((await spawnShell(shell.argv, ["-s"], bx.home, again.script)).code).toBe(0);
      expect(provCount(await bx.read())).toBe(1);
      expect(mainCount(await bx.read())).toBe(1);
    });

    test("the install refuses a symbolic link and a home path that the line cannot hold", async () => {
      const bx = await box(shell.argv);
      await rename(bx.keys, `${bx.keys}.real`);
      await symlink(`${bx.keys}.real`, bx.keys);
      const install = linuxInstallScript({
        targetId: "nas",
        mainPublicLine: MAIN,
        provisionerPublicLine: PROV,
        localSource: LOCAL,
        sources: ["10.0.0.1"],
      });
      expect((await spawnShell(shell.argv, ["-s"], bx.home, install.script)).code).toBe(1);
      const spaced = await mkdtemp(join(tmpdir(), "prov sh-"));
      made.push(spaced);
      const result = await spawnShell(shell.argv, ["-s"], spaced, install.script);
      expect(result.code).toBe(1);
      expect(await gone(join(spaced, ".claude-rc", "provisioner-nas.sh"))).toBe(true);
    });

    for (const [name, build] of [
      ["the owner key is the last line", (prov: string) => `${prov}\n${OWNER}`],
      ["the provisioner line is the last line", (prov: string) => `${OWNER}\n${prov}`],
    ] as const) {
      test(`on keeps a last line without a newline when ${name}`, async () => {
        const bx = await box(shell.argv, { main: false });
        const prov = provLineOf(await bx.read());
        const mainLine = `from="10.0.0.1",restrict ${MAIN}`;
        const start = build(prov);
        await writeFile(bx.keys, start);
        expect(await bx.run("on")).toEqual({ code: 0, out: "ok on 10.0.0.1\n", err: "" });
        const first = await bx.read();
        expect(first).toBe(`${start}\n${mainLine}\n`);
        expect(first).toContain(`${OWNER}\n`);
        expect(mainCount(first)).toBe(1);
        expect(provCount(first)).toBe(1);
        expect((await bx.run("on")).code).toBe(0);
        expect(await bx.read()).toBe(first);
        expect((await bx.run("status")).out).toBe("ok status present 10.0.0.1\n");
      });

      test(`sources keeps a last line without a newline when ${name}`, async () => {
        const bx = await box(shell.argv, { main: false });
        const prov = provLineOf(await bx.read());
        const oldMain = `from="10.0.0.1",restrict ${MAIN}`;
        const newMain = `from="10.0.0.2",restrict ${MAIN}`;
        const plain = build(prov);
        const start = plain.startsWith(prov) ? `${oldMain}\n${plain}` : `${OWNER}\n${oldMain}\n${prov}`;
        await writeFile(bx.keys, start);
        expect(await bx.run("sources 10.0.0.2")).toEqual({ code: 0, out: "ok sources 10.0.0.2\n", err: "" });
        const first = await bx.read();
        const rest = start.replace(`${oldMain}\n`, "");
        expect(first).toBe(`${rest}\n${newMain}\n`);
        expect(mainCount(first)).toBe(1);
        expect(first).toContain(`${OWNER}\n`);
        expect((await bx.run("sources 10.0.0.2")).code).toBe(0);
        expect(await bx.read()).toBe(first);
        expect((await bx.run("status")).out).toBe("ok status present 10.0.0.2\n");
      });
    }

    test("the guard stops a bad edit of uninstall and of a line of the owner", async () => {
      for (const kind of ["main", "other"] as const) {
        const bx = await box(shell.argv);
        await writeFile(
          bx.script,
          linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: PBLOB, guardTest: kind }),
        );
        await chmod(bx.script, 0o700);
        const before = await readFile(bx.keys);
        const result = await bx.run("uninstall");
        expect(result.code, kind).toBe(4);
        expect(result.err).toMatch(/^error guard /);
        expect(Buffer.compare(await readFile(bx.keys), before), kind).toBe(0);
        expect(await gone(bx.script)).toBe(false);
        expect(await gone(bx.state)).toBe(false);

        for (const command of ["on", "off", "sources 10.0.0.9"]) {
          const other = await bx.run(command);
          if (other.code === 0) continue;
          expect(other.code, `${kind} ${command}`).toBe(4);
          expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
          break;
        }
      }
    });

    test("a failing tool ends with exit 6 and not with exit 2", async () => {
      // busybox sh runs its own awk without a PATH search, so no tool can be taken away from it
      if (shell.name === "busybox sh") return;
      const bx = await box(shell.argv);
      const tools = join(bx.home, "tools");
      await mkdir(tools);

      for (const tool of [
        "cp",
        "mv",
        "tail",
        "grep",
        "rm",
        "chmod",
        "mkdir",
        "cat",
        "head",
        "rmdir",
        "touch",
        "sed",
        "cmp",
        "flock",
      ]) {
        const found = Bun.which(tool);
        if (found) await symlink(found, join(tools, tool));
      }

      const before = await readFile(bx.keys);

      for (const command of ["on", "off", "status", "sources 10.0.0.3", "uninstall"]) {
        // no awk in the path: the script cannot count or edit lines
        const result = await spawnShell(shell.argv, [bx.script], bx.home, undefined, command, tools);
        expect(result.code, command).toBe(6);
        expect(result.err).toMatch(/^error write-failed /m);
      }

      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
    });

    test("an edit sets mode 600 on a key file that had mode 644", async () => {
      const bx = await box(shell.argv);
      await chmod(bx.keys, 0o644);
      await bx.run("off");
      expect(await mode(bx.keys)).toBe(0o600);
      await chmod(bx.keys, 0o644);
      await bx.run("on");
      expect(await mode(bx.keys)).toBe(0o600);
    });

    test("an error text does not hold the home path", async () => {
      const bx = await box(shell.argv);
      const tools = join(bx.home, "tools");
      await mkdir(tools);

      for (const tool of [
        "mv",
        "tail",
        "grep",
        "rm",
        "chmod",
        "mkdir",
        "cat",
        "head",
        "rmdir",
        "touch",
        "sed",
        "cmp",
        "flock",
        "awk",
      ]) {
        const found = Bun.which(tool);
        if (found) await symlink(found, join(tools, tool));
      }

      const falsePath = Bun.which("false");
      if (falsePath) await symlink(falsePath, join(tools, "cp"));
      const result = await spawnShell(shell.argv, [bx.script], bx.home, undefined, "off", tools);
      expect(result.err).not.toContain(bx.home);
      if (shell.name !== "busybox sh") expect(result.code).toBe(6);
    });

    test("the line of the install equals provisionerLine", async () => {
      const bx = await box(shell.argv);
      const written = (await bx.read()).split("\n").find((line) => line.endsWith("claude-rc-provisioner:nas"));
      expect(written).toBe(provisionerLine({ publicLine: PROV, source: LOCAL, scriptPath: bx.script }));
    });

    test("a command with a key line is refused and changes nothing", async () => {
      const bx = await box(shell.argv);
      const before = await readFile(bx.keys);
      const keyLine = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIevil evil@box";
      const commands = [
        `on ${keyLine}`,
        `off ${keyLine}`,
        `status ${keyLine}`,
        `uninstall ${keyLine}`,
        `sources 10.0.0.1 ${keyLine}`,
        `sources 10.0.0.1\n${keyLine}`,
        `sources ${keyLine}`,
        `on\n${keyLine}`,
        keyLine,
        `sources 10.0.0.1,${keyLine.replaceAll(" ", ",")}`,
      ];

      for (const command of commands) {
        const result = await bx.run(command);
        expect(result.code, JSON.stringify(command)).toBe(2);
      }

      expect(Buffer.compare(await readFile(bx.keys), before)).toBe(0);
      expect(await bx.read()).not.toContain("evil");
    });

    test("the install refuses a home path over the length of the line rule", async () => {
      const install = linuxInstallScript({
        targetId: "nas",
        mainPublicLine: MAIN,
        provisionerPublicLine: PROV,
        localSource: LOCAL,
        sources: ["10.0.0.1"],
      });
      const root = await mkdtemp(join(tmpdir(), "provlong-"));
      made.push(root);
      let deep = root;
      while (deep.length < 700) deep = join(deep, "d".repeat(200));
      await mkdir(deep, { recursive: true });
      const accepted = deep.length + "/.claude-rc/provisioner-nas.sh".length;
      expect(accepted).toBeLessThanOrEqual(1100);

      // pad the home path so that the script path is 1024 characters (accepted) and then 1025 (refused)
      const padFor = async (total: number) => {
        const home = deep + "/" + "p".repeat(total - "/.claude-rc/provisioner-nas.sh".length - deep.length - 1);
        await mkdir(join(home, ".ssh"), { recursive: true });
        await writeFile(join(home, ".ssh", "authorized_keys"), "");
        return home;
      };

      const okHome = await padFor(1024);
      const okRun = await spawnShell(shell.argv, ["-s"], okHome, install.script);
      expect(okRun.code, okRun.err).toBe(0);
      const badHome = await padFor(1025);
      const badRun = await spawnShell(shell.argv, ["-s"], badHome, install.script);
      expect(badRun.code).toBe(1);
      expect(badRun.err).toContain("too long");
    });
  });
}
