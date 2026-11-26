import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionScript } from "../src/sshprovision";
import {
  ROUTER_APPLETS,
  ROUTER_MAX_VALUE,
  parseAnswer,
  routerInstallScript,
  routerProvisionerLine,
  routerScript,
  routerScriptPath,
} from "../src/sshprovisioner";
import vectors from "../src/sshprovisioner.vectors.json";
import { authorizedKeysLine, DROPBEAR_OPTIONS } from "../src/sshtargets";

// The router version of the provisioner script (Dropbear on Asuswrt-Merlin). There is no router here, so the tests run
// the script under `busybox sh` and `dash` with a fake `nvram` program and a temporary folder that stands in for `/`.
// The fake `nvram` behaves like the real one where the source of the firmware shows it: `get` prints the value and one
// newline, `set` splits at the first `=`, and a set that the firmware drops still exits 0. Only the fake can fail a
// `commit` with an exit code other than 0. The real program always exits 0 (see the report of Task 8).

const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGmainmainmainmainmainmainmainmainmainmain";
const PBLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGprovprovprovprovprovprovprovprovprovprov";
const MAIN = `ssh-ed25519 ${BLOB} claude-rc:rt`;
const PROV = `ssh-ed25519 ${PBLOB} claude-rc-provisioner:rt`;
const LOCAL = "192.168.1.103";
const OWNER = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB owner@laptop";
const OWNER2 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIother phone";
const FROM_LOCAL = `${LOCAL} 50000 192.168.1.1 22`;
/** The main line of a Dropbear target: the four flags and no `from=`, whatever the list (a ruling of the owner). */
const ML = authorizedKeysLine(MAIN, ["10.0.0.1"], "dropbear");

const SHELLS: { name: string; argv: string[] }[] = [];
const busyboxPath = Bun.which("busybox");
const dashPath = Bun.which("dash");
if (busyboxPath) SHELLS.push({ name: "busybox sh", argv: [busyboxPath, "sh"] });
if (dashPath) SHELLS.push({ name: "dash", argv: [dashPath] });

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const gone = (path: string) =>
  lstat(path).then(
    () => false,
    () => true,
  );
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const tr = (value: string) => value.replaceAll(">", "\n");

/** A fake `nvram`: RAM and flash are files in `nv`, and every set and commit goes into `nv/log`. */
function fakeNvram(nv: string): string {
  return [
    "#!/bin/sh",
    "PATH=/usr/bin:/bin",
    `d='${nv}'`,
    'case "$1" in',
    '  get) if [ -f "$d/ram.$2" ]; then cat "$d/ram.$2"; fi; printf \'\\n\' ;;',
    '  set) n=${2%%=*}; v=${2#*=}; echo "set $n" >> "$d/log"',
    '    if [ ! -e "$d/drop-set" ]; then printf \'%s\' "$v" > "$d/ram.$n"; fi ;;',
    '  commit) echo commit >> "$d/log"',
    '    if [ -e "$d/fail-commit" ]; then exit 1; fi',
    '    for f in "$d"/ram.*; do cp "$f" "$d/flash.${f##*/ram.}"; done ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

interface Router {
  root: string;
  nv: string;
  bin: string;
  keys: string;
  script: string;
  state: string;
  path: string;
  install: (input?: Partial<Parameters<typeof routerInstallScript>[0]>) => Promise<Result>;
  run: (command: string | undefined, env?: Record<string, string>) => Promise<Result>;
  value: () => Promise<string>;
  flash: () => Promise<string>;
  live: () => Promise<string>;
  log: () => Promise<string[]>;
  setValue: (value: string) => Promise<void>;
  reboot: () => Promise<void>;
}

interface Result {
  code: number;
  out: string;
  err: string;
}

async function spawn(argv: string[], env: Record<string, string>, stdin?: string): Promise<Result> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/**
 * A temporary router. The value of `sshd_authkeys` starts with the lines of the owner and the main line that the owner
 * pasted into the web page (joined with `>`, as the web page stores them), and the live file is made from it as the
 * firmware does at boot. Then the install of the provisioner runs, unless `install` is false.
 */
async function router(
  shell: string[],
  options: {
    value?: string;
    install?: boolean;
    sources?: string[];
    path?: string;
    guardTest?: true | "main" | "other";
  } = {},
): Promise<Router> {
  const root = await mkdtemp(join(tmpdir(), "provrt-"));
  made.push(root);
  const nv = join(root, "nv");
  const bin = join(root, "bin");
  for (const dir of [nv, bin, join(root, "jffs"), join(root, "tmp")]) await mkdir(dir);
  await mkdir(join(root, "root", ".ssh"), { recursive: true, mode: 0o700 });
  await writeFile(join(bin, "nvram"), fakeNvram(nv), { mode: 0o755 });
  const sources = options.sources ?? ["10.0.0.1"];
  const value = options.value ?? [OWNER, OWNER2, authorizedKeysLine(MAIN, sources, "dropbear")].join(">");
  const keys = join(root, "root", ".ssh", "authorized_keys");
  await writeFile(join(nv, "ram.sshd_authkeys"), value);
  await writeFile(join(nv, "flash.sshd_authkeys"), value);
  await writeFile(keys, tr(value), { mode: 0o600 });
  const path = options.path ?? `${bin}:${process.env.PATH ?? ""}`;
  const script = join(root, "jffs", "scripts", `claude-rc-provisioner-rt.sh`);

  const rt: Router = {
    root,
    nv,
    bin,
    keys,
    script,
    state: join(root, "jffs", "scripts", "claude-rc-provisioner-rt.from"),
    path,
    install: (input = {}) =>
      spawn(
        [...shell, "-s"],
        { PATH: path },
        routerInstallScript({
          targetId: "rt",
          mainPublicLine: MAIN,
          provisionerPublicLine: PROV,
          localSource: LOCAL,
          sources,
          root,
          ...input,
        }).script,
      ),
    run: (command, env = {}) => {
      const all: Record<string, string> = { PATH: path, SSH_CONNECTION: FROM_LOCAL, ...env };
      if (command !== undefined) all.SSH_ORIGINAL_COMMAND = command;
      return spawn([...shell, script], all);
    },
    value: () => readFile(join(nv, "ram.sshd_authkeys"), "utf8"),
    flash: () => readFile(join(nv, "flash.sshd_authkeys"), "utf8"),
    live: () => readFile(keys, "utf8"),
    log: async () => (await readFile(join(nv, "log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    setValue: async (next) => {
      await writeFile(join(nv, "ram.sshd_authkeys"), next);
      await writeFile(join(nv, "flash.sshd_authkeys"), next);
      await writeFile(keys, tr(next), { mode: 0o600 });
    },
    // What start_sshd of the firmware does at boot: the value from flash, each `>` becomes a newline.
    reboot: async () => {
      const kept = await readFile(join(nv, "flash.sshd_authkeys"), "utf8");
      await writeFile(join(nv, "ram.sshd_authkeys"), kept);
      await writeFile(keys, tr(kept).slice(0, ROUTER_MAX_VALUE), { mode: 0o600 });
    },
  };

  if (options.install !== false) {
    const done = await rt.install();
    expect(done.err).toBe("");
    expect(done.out.split("\n")[0]).toBe(`ok installed ${script}`);
    expect(done.code).toBe(0);
    await writeFile(join(nv, "log"), "");
  }

  if (options.guardTest !== undefined) {
    await writeFile(
      script,
      routerScript({
        targetId: "rt",
        mainPublicLine: MAIN,
        provisionerBlob: PBLOB,
        localSource: LOCAL,
        root,
        guardTest: options.guardTest,
      }),
      { mode: 0o700 },
    );
  }

  return rt;
}

const linesOf = (text: string) => text.split(/[>\n]/).filter(Boolean);
const count = (text: string, needle: string) => linesOf(text).filter((line) => line.endsWith(needle)).length;
const provCount = (text: string) => count(text, `${PBLOB} claude-rc-provisioner:rt`);
const mainCount = (text: string) => count(text, `${BLOB} claude-rc:rt`);
const provLine = (root: string) =>
  routerProvisionerLine({ publicLine: PROV, scriptPath: join(root, "jffs", "scripts", "claude-rc-provisioner-rt.sh") });

describe("router version: pure parts", () => {
  test("the script path is in /jffs/scripts", () => {
    expect(routerScriptPath("rt")).toBe("/jffs/scripts/claude-rc-provisioner-rt.sh");
    expect(() => routerScriptPath("../x")).toThrow();
  });

  test("the provisioner line has the four no flags and command and no from, because Dropbear refuses a line with from", () => {
    const line = routerProvisionerLine({ publicLine: PROV, scriptPath: routerScriptPath("rt") });
    expect(line).toBe(
      `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,command="/jffs/scripts/claude-rc-provisioner-rt.sh" ${PROV}`,
    );
    expect(line).not.toContain("from=");
  });

  test("the install refuses a local source that is a host name, because the script compares addresses", () => {
    const input = { targetId: "rt", mainPublicLine: MAIN, provisionerPublicLine: PROV, sources: ["10.0.0.1"] };
    expect(() => routerInstallScript({ ...input, localSource: "hub.lan" })).toThrow();
    expect(() => routerInstallScript({ ...input, localSource: "fe80::1" })).not.toThrow();
    expect(() => routerInstallScript({ ...input, localSource: LOCAL, sources: ["10.0.0.*"] })).toThrow();
    expect(() => routerInstallScript({ ...input, localSource: LOCAL, mainPublicLine: PROV })).toThrow();
  });

  test("the script uses a mkdir lock and no flock", () => {
    const text = routerScript({ targetId: "rt", mainPublicLine: MAIN, provisionerBlob: PBLOB, localSource: LOCAL });
    expect(text).not.toContain("flock");
    expect(text).toContain('mkdir "$lock"');
    expect(text).not.toContain("guard-test");
    // BusyBox ash of Merlin is built without the builtin `command` (CONFIG_ASH_CMDCMD is not set).
    expect(text).not.toMatch(/\bcommand -v\b/);
    expect(text).not.toContain("service ");
  });

  test("the answer of the install parses as installed, with info lines after it", () => {
    expect(parseAnswer(`ok installed ${routerScriptPath("rt")}\ninfo something\n`)).toEqual({
      kind: "installed",
      path: routerScriptPath("rt"),
    });
  });
});

if (!busyboxPath) {
  describe("router version under busybox sh (busybox missing: skipped)", () => {
    test.skip("busybox is not installed", () => {});
  });
}

for (const shell of SHELLS) {
  describe(`router version under ${shell.name}`, () => {
    test("a dropbear install writes the script and both lines with a fake nvram", async () => {
      const rt = await router(shell.argv, { install: false });
      const done = await rt.install();
      expect(done.code).toBe(0);
      expect(done.err).toBe("");
      const [first, ...info] = done.out.trim().split("\n");
      expect(first).toBe(`ok installed ${rt.script}`);
      const before = [OWNER, OWNER2, ML].join(">");
      const value = await rt.value();
      expect(info).toEqual([
        `info nvram sshd_authkeys had 3 lines, separator >, ${before.length} of 3499 bytes`,
        `info nvram sshd_authkeys has 4 lines, separator >, ${value.length} of 3499 bytes`,
      ]);

      expect(value).toBe([OWNER, OWNER2, ML, provLine(rt.root)].join(">"));
      expect(await rt.flash()).toBe(value);
      expect(await rt.live()).toBe(tr(value));
      expect(await rt.log()).toEqual(["set sshd_authkeys", "commit"]);
      expect(await mode(rt.script)).toBe(0o700);
      expect(await mode(rt.state)).toBe(0o600);
      expect(await mode(rt.keys)).toBe(0o600);
      expect(await readFile(rt.state, "utf8")).toBe("10.0.0.1\n");
      expect(await gone(join(rt.root, "tmp", "claude-rc-provisioner.lock"))).toBe(true);
    });

    test("the install carries the main line of the add into nvram, and a reboot keeps both lines", async () => {
      const rt = await router(shell.argv, { value: OWNER, install: false });
      // The add of today: the provision script writes the main line into the live file only.
      const add = provisionScript("dropbear", authorizedKeysLine(MAIN, ["10.0.0.1"], "dropbear")).script;
      const added = await spawn([...shell.argv, "-s"], { PATH: rt.path, HOME: join(rt.root, "root") }, add);
      expect(added.code).toBe(0);
      expect(await rt.live()).toBe(`${OWNER}\n${ML}\n`);
      expect(await rt.value()).toBe(OWNER);

      const done = await rt.install();
      expect(done.code).toBe(0);
      expect(await rt.value()).toBe(`${OWNER}>${provLine(rt.root)}>${ML}`);
      expect(await rt.flash()).toBe(await rt.value());
      expect(await rt.live()).toBe(`${OWNER}\n${provLine(rt.root)}\n${ML}`);

      await rt.reboot();
      expect(linesOf(await rt.live())).toEqual([OWNER, provLine(rt.root), ML]);
      expect((await rt.run("status")).out).toBe("ok status present 10.0.0.1\n");
    });

    test("the install adds no main line when neither nvram nor the live file has one", async () => {
      const rt = await router(shell.argv, { value: OWNER });
      expect(mainCount(await rt.value())).toBe(0);
      expect(mainCount(await rt.live())).toBe(0);
    });

    test("a second install changes nothing in nvram", async () => {
      const rt = await router(shell.argv);
      const before = await rt.value();
      const done = await rt.install();
      expect(done.code).toBe(0);
      expect(await rt.value()).toBe(before);
      expect(await rt.log()).toEqual([]);
    });

    test("a second install does not write the script and the state file again", async () => {
      const rt = await router(shell.argv);
      const times = async () => [(await stat(rt.script)).mtimeMs, (await stat(rt.state)).mtimeMs];
      const before = await times();
      await Bun.sleep(20);
      expect((await rt.install()).code).toBe(0);
      expect(await times()).toEqual(before);
    });

    test("the install refuses a router without /jffs", async () => {
      const rt = await router(shell.argv, { install: false });
      await rm(join(rt.root, "jffs"), { recursive: true });
      const done = await rt.install();
      expect(done.code).not.toBe(0);
      expect(done.err).toContain("/jffs");
      expect(await rt.log()).toEqual([]);
    });

    test("every write calls nvram set and then nvram commit", async () => {
      const rt = await router(shell.argv);

      // `sources` writes no line on a router (the line has no list), so it is not in this list.
      for (const command of ["off", "on", "uninstall"]) {
        await writeFile(join(rt.nv, "log"), "");
        const result = await rt.run(command);
        expect(result.err, command).toBe("");
        expect(result.code, command).toBe(0);
        expect(await rt.log(), command).toEqual(["set sshd_authkeys", "commit"]);
        expect(await rt.flash(), command).toBe(await rt.value());
        expect(await rt.live(), command).toBe(tr(await rt.value()));
      }
    });

    test("a second run changes nothing", async () => {
      const rt = await router(shell.argv);

      for (const command of ["on", "off", "sources 10.0.0.1"]) {
        await rt.run(command);
        await writeFile(join(rt.nv, "log"), "");
        const before = await rt.value();
        const live = await readFile(rt.keys);
        const mtime = (await stat(rt.keys)).mtimeMs;
        expect((await rt.run(command)).code, command).toBe(0);
        expect(await rt.log(), command).toEqual([]);
        expect(await rt.value(), command).toBe(before);
        expect(Buffer.compare(await readFile(rt.keys), live), command).toBe(0);
        expect((await stat(rt.keys)).mtimeMs, command).toBe(mtime);
      }
    });

    test("status reads only, and reports present and absent with the list", async () => {
      const rt = await router(shell.argv);
      expect(await rt.run("status")).toEqual({ code: 0, out: "ok status present 10.0.0.1\n", err: "" });
      await rt.run("off");
      await writeFile(join(rt.nv, "log"), "");
      expect((await rt.run("status")).out).toBe("ok status absent 10.0.0.1\n");
      expect(await rt.log()).toEqual([]);
      await rm(rt.state);
      expect((await rt.run("status")).out).toBe("ok status absent\n");
    });

    test("status says absent when the live file lacks the line that nvram holds", async () => {
      const rt = await router(shell.argv);
      await writeFile(rt.keys, `${OWNER}\n`);
      expect((await rt.run("status")).out).toBe("ok status absent 10.0.0.1\n");
    });

    test("the main line has the four flags and no from, and sources does not touch it", async () => {
      const rt = await router(shell.argv);
      expect(ML).toBe(`${DROPBEAR_OPTIONS} ${MAIN}`);
      const before = await rt.value();
      const live = await readFile(rt.keys);
      await writeFile(join(rt.nv, "log"), "");
      const result = await rt.run("sources 10.0.0.2,fe80::1");
      expect(result).toEqual({ code: 0, out: "ok sources 10.0.0.2,fe80::1\n", err: "" });
      expect(await rt.value()).toBe(before);
      expect(Buffer.compare(await readFile(rt.keys), live)).toBe(0);
      expect(await rt.log()).toEqual([]);
      expect(await readFile(rt.state, "utf8")).toBe("10.0.0.2,fe80::1\n");
      expect((await rt.run("status")).out).toBe("ok status present 10.0.0.2,fe80::1\n");
    });

    test("sources replaces an older main line with from by the line without it", async () => {
      const old = authorizedKeysLine(MAIN, ["10.0.0.1"]);
      const rt = await router(shell.argv, { value: `${OWNER}>${old}` });
      expect((await rt.run("status")).out).toBe("ok status absent 10.0.0.1\n");
      expect((await rt.run("sources 10.0.0.1")).code).toBe(0);
      const lines = linesOf(await rt.value());
      expect(lines).toContain(ML);
      expect(lines).not.toContain(old);
      expect(mainCount(await rt.value())).toBe(1);
      expect((await rt.run("status")).out).toBe("ok status present 10.0.0.1\n");
    });

    test("sources on an absent line writes only the state file", async () => {
      const rt = await router(shell.argv);
      await rt.run("off");
      await writeFile(join(rt.nv, "log"), "");
      expect((await rt.run("sources 10.0.0.9")).code).toBe(0);
      expect(await rt.log()).toEqual([]);
      expect(await readFile(rt.state, "utf8")).toBe("10.0.0.9\n");
      expect((await rt.run("on")).out).toBe("ok on 10.0.0.9\n");
      expect(linesOf(await rt.value())).toContain(ML);
    });

    test("owner keys survive in both the nvram value and the live file", async () => {
      const rt = await router(shell.argv);

      for (const command of ["off", "on", "sources 10.0.0.2", "status", "uninstall"]) {
        expect((await rt.run(command)).code, command).toBe(0);
        const value = await rt.value();
        expect(value.startsWith(`${OWNER}>${OWNER2}`), command).toBe(true);
        expect(linesOf(await rt.live()).slice(0, 2), command).toEqual([OWNER, OWNER2]);
        expect(linesOf(await rt.flash()).slice(0, 2), command).toEqual([OWNER, OWNER2]);
      }
    });

    test("uninstall removes both lines, the state file and the script, and keeps the folder", async () => {
      const rt = await router(shell.argv);
      expect(await rt.run("uninstall")).toEqual({ code: 0, out: "ok uninstall\n", err: "" });
      expect(await rt.value()).toBe(`${OWNER}>${OWNER2}`);
      expect(await rt.live()).toBe(`${OWNER}\n${OWNER2}`);
      expect(await gone(rt.script)).toBe(true);
      expect(await gone(rt.state)).toBe(true);
      expect(await gone(join(rt.root, "jffs", "scripts"))).toBe(false);
    });

    test("after a reboot the live file holds what the script wrote", async () => {
      const rt = await router(shell.argv);
      await rt.run("off");
      await rt.run("sources 10.0.0.7");
      await rt.run("on");
      await rt.reboot();
      expect(linesOf(await rt.live())).toContain(ML);
      expect(provCount(await rt.live())).toBe(1);
      expect((await rt.run("status")).out).toBe("ok status present 10.0.0.7\n");
    });

    test("the format found in nvram is preserved", async () => {
      const main = ML;

      // A value with newlines and a newline at the end stays so.
      const nl = await router(shell.argv, { value: `${OWNER}\n${main}\n` });
      await nl.run("sources 10.0.0.2");
      const nlValue = await nl.value();
      expect(nlValue).not.toContain(">");
      expect(nlValue.endsWith("\n")).toBe(true);
      expect(nlValue.startsWith(`${OWNER}\n`)).toBe(true);

      // A value with `>` and one at the end keeps the one at the end.
      const trail = await router(shell.argv, { value: `${OWNER}>${main}>` });
      await trail.run("off");
      expect(await trail.value()).toBe(`${OWNER}>${provLine(trail.root)}>`);

      // A value with one line and no separator gets `>`, as the web page writes it.
      const single = await router(shell.argv, { value: OWNER });
      expect(await single.value()).toBe(`${OWNER}>${provLine(single.root)}`);
      await single.run("on");
      expect(await single.value()).toBe(`${OWNER}>${provLine(single.root)}>${main}`);

      // An empty value.
      const empty = await router(shell.argv, { value: "" });
      expect(await empty.value()).toBe(provLine(empty.root));
    });

    test("a value with both separators is refused with exit 3 and nothing is written", async () => {
      const rt = await router(shell.argv);
      const mixed = `${OWNER}\n${(await rt.value()).split(">").slice(1).join(">")}`;
      await rt.setValue(mixed);
      await writeFile(join(rt.nv, "log"), "");
      const result = await rt.run("off");
      expect(result.code).toBe(3);
      expect(result.err).toMatch(/^error unsafe-file /);
      expect(await rt.log()).toEqual([]);
      expect(await rt.value()).toBe(mixed);
    });

    test("a value over the size limit is refused before nvram set", async () => {
      const rt = await router(shell.argv, { value: OWNER });
      // Pad a line of the owner so that `on` (a new main line and one separator) makes the value one byte too long.
      const now = (await rt.value()).length;
      const grow = ML.length + 1;
      const pad = (extra: number) => `${OWNER}${"x".repeat(ROUTER_MAX_VALUE - now - grow + extra)}`;

      await rt.setValue((await rt.value()).replace(OWNER, pad(1)));
      await writeFile(join(rt.nv, "log"), "");
      const live = await readFile(rt.keys);
      const refused = await rt.run("on");
      expect(refused.code).toBe(4);
      expect(refused.err).toMatch(/^error guard .*3499/);
      expect(await rt.log()).toEqual([]);
      expect(Buffer.compare(await readFile(rt.keys), live)).toBe(0);

      // Exactly at the limit, the write goes through.
      await rt.setValue((await rt.value()).replace(pad(1), pad(0)));
      const taken = await rt.run("on");
      expect(taken.err).toBe("");
      expect(taken.code).toBe(0);
      expect((await rt.value()).length).toBe(ROUTER_MAX_VALUE);
    });

    test("a failed nvram commit leaves the live file unchanged and puts the old value back", async () => {
      const rt = await router(shell.argv);
      const before = await rt.value();
      const live = await readFile(rt.keys);
      await writeFile(join(rt.nv, "fail-commit"), "");
      const result = await rt.run("off");
      expect(result.code).toBe(6);
      expect(result.err).toMatch(/^error write-failed /);
      expect(await rt.value()).toBe(before);
      expect(await rt.flash()).toBe(before);
      expect(Buffer.compare(await readFile(rt.keys), live)).toBe(0);
      // set, commit, then the set of the old value (no second commit)
      expect(await rt.log()).toEqual(["set sshd_authkeys", "commit", "set sshd_authkeys"]);
    });

    test("a set that nvram drops is found by the read back, and the live file stays", async () => {
      const rt = await router(shell.argv);
      const live = await readFile(rt.keys);
      await writeFile(join(rt.nv, "drop-set"), "");
      const result = await rt.run("off");
      expect(result.code).toBe(6);
      expect(result.err).toMatch(/^error write-failed /);
      expect(await rt.log()).not.toContain("commit");
      expect(Buffer.compare(await readFile(rt.keys), live)).toBe(0);
    });

    test("the guard stops a bad edit before nvram set", async () => {
      for (const kind of [true, "main", "other"] as const) {
        const rt = await router(shell.argv, { guardTest: kind });
        const before = await rt.value();
        const live = await readFile(rt.keys);

        // With the main line present, `on` and `sources` write nothing, so only commands that write are here.
        for (const command of ["off", "uninstall"]) {
          // Without the provisioner line is what uninstall wants, so that bad edit passes there.
          if (kind === true && command === "uninstall") continue;
          const result = await rt.run(command);
          expect(result.code, `${kind} ${command}`).toBe(4);
          expect(result.err).toMatch(/^error guard /);
          expect(await rt.log(), `${kind} ${command}`).toEqual([]);
          expect(await rt.value()).toBe(before);
          expect(Buffer.compare(await readFile(rt.keys), live)).toBe(0);
          expect(await gone(rt.script)).toBe(false);
        }
      }
    });

    test("never removes the provisioner line except on uninstall", async () => {
      const rt = await router(shell.argv);

      for (const command of ["off", "on", "sources 10.0.0.5", "on", "off", "status", "sources 10.0.0.6"]) {
        await rt.run(command);
        expect(provCount(await rt.value()), command).toBe(1);
        expect(provCount(await rt.live()), command).toBe(1);
      }

      await rt.run("uninstall");
      expect(provCount(await rt.value())).toBe(0);
    });

    test("refuses every reject vector with exit 2 and changes nothing", async () => {
      const rt = await router(shell.argv);
      const before = await rt.value();
      const live = await readFile(rt.keys);
      const state = await readFile(rt.state);

      for (const text of vectors.reject) {
        if (text.includes("\u0000")) continue;
        const result = await rt.run(text);
        expect(result.code, JSON.stringify(text.slice(0, 40))).toBe(2);
        expect(result.out).toBe("");
        expect(result.err).toMatch(/^error bad-command /);
      }

      expect((await rt.run(undefined)).code).toBe(2);
      expect(await rt.log()).toEqual([]);
      expect(await rt.value()).toBe(before);
      expect(Buffer.compare(await readFile(rt.keys), live)).toBe(0);
      expect(Buffer.compare(await readFile(rt.state), state)).toBe(0);
    });

    test("takes every accept vector that needs no state change", async () => {
      const rt = await router(shell.argv);
      await rt.run("off");

      for (const text of vectors.accept.filter((item) => item.startsWith("sources "))) {
        const result = await rt.run(text);
        expect(result.code, text.slice(0, 30)).toBe(0);
        expect(result.out).toBe(`ok ${text}\n`);
      }
    });

    test("a command with a key line is refused and changes nothing", async () => {
      const rt = await router(shell.argv);
      const before = await rt.value();

      for (const text of [
        `sources 10.0.0.1 ${OWNER}`,
        `on ${MAIN}`,
        `sources 10.0.0.1>${OWNER}`,
        `sources "x",command="sh"`,
      ]) {
        expect((await rt.run(text)).code, text).toBe(2);
      }

      expect(await rt.value()).toBe(before);
    });

    test("refuses a login from another source address with exit 2", async () => {
      const rt = await router(shell.argv);
      const before = await rt.value();

      for (const env of [
        { SSH_CONNECTION: "192.168.1.104 50000 192.168.1.1 22" },
        { SSH_CONNECTION: "192.168.1.1030 50000 192.168.1.1 22" },
        { SSH_CONNECTION: "" },
      ]) {
        const result = await rt.run("off", env);
        expect(result.code, env.SSH_CONNECTION).toBe(2);
        expect(result.err).toMatch(/^error bad-source /);
      }

      expect(await rt.value()).toBe(before);
      expect((await rt.run("status", { SSH_CONNECTION: `::ffff:${FROM_LOCAL}` })).code).toBe(0);
      expect((await rt.run("status", { SSH_CONNECTION: "", SSH_CLIENT: `${LOCAL} 5 22` })).code).toBe(0);
    });

    test("on without a state list fails with exit 5", async () => {
      const rt = await router(shell.argv);
      await rt.run("off");
      await rm(rt.state);
      const result = await rt.run("on");
      expect(result.code).toBe(5);
      expect(result.err).toMatch(/^error no-sources /);
    });

    test("refuses a symbolic link at the live key folder, the key file and the state file with exit 3", async () => {
      for (const which of ["keys", "state", "dir"] as const) {
        const rt = await router(shell.argv);
        const target = join(rt.root, "elsewhere");

        if (which === "keys") {
          await writeFile(target, await rt.live());
          await rm(rt.keys);
          await symlink(target, rt.keys);
        } else if (which === "state") {
          await writeFile(target, "10.0.0.1\n");
          await rm(rt.state);
          await symlink(target, rt.state);
        } else {
          await mkdir(target);
          await rm(join(rt.root, "root", ".ssh"), { recursive: true });
          await symlink(target, join(rt.root, "root", ".ssh"));
        }

        const result = await rt.run("off");
        expect(result.code, which).toBe(3);
        expect(result.err).toMatch(/^error unsafe-file /);
        expect(await rt.log()).toEqual([]);
      }
    });

    test("the script uses a mkdir lock and waits for it", async () => {
      const rt = await router(shell.argv);
      const lock = join(rt.root, "tmp", "claude-rc-provisioner.lock");
      await mkdir(lock);
      const started = Date.now();
      const running = rt.run("off");
      await Bun.sleep(1500);
      expect(await rt.log()).toEqual([]);
      await rm(lock, { recursive: true });
      const result = await running;
      expect(result.code).toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
      expect(await gone(lock)).toBe(true);
    });

    test("a line only in the live file goes at the next write, as at the next reboot", async () => {
      const rt = await router(shell.argv);
      await writeFile(rt.keys, `${await rt.live()}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlive only@box\n`);
      await rt.run("off");
      expect(await rt.live()).toBe(tr(await rt.value()));
      expect(await rt.live()).not.toContain("only@box");
    });

    test("leaves no temporary file behind", async () => {
      const rt = await router(shell.argv);
      for (const command of ["off", "on", "sources 10.0.0.3", "status"]) await rt.run(command);
      await writeFile(join(rt.nv, "fail-commit"), "");
      await rt.run("off");
      const listing = async (dir: string) =>
        (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, dot: true }))).sort();
      expect(await listing(join(rt.root, "tmp"))).toEqual([]);
      expect(await listing(join(rt.root, "root", ".ssh"))).toEqual(["authorized_keys"]);
      expect(await listing(join(rt.root, "jffs", "scripts"))).toEqual([
        "claude-rc-provisioner-rt.from",
        "claude-rc-provisioner-rt.sh",
      ]);
    });

    test("an error text holds no key and no folder path", async () => {
      const rt = await router(shell.argv);
      await writeFile(join(rt.nv, "fail-commit"), "");
      const result = await rt.run("off");
      expect(result.err).not.toContain(rt.root);
      expect(result.err).not.toContain(BLOB);
      expect(result.err.split("\n").filter(Boolean)).toHaveLength(1);
    });
  });
}

// The script must run with the applets of Merlin's BusyBox only. Under dash (no applets inside), the PATH holds the
// fake nvram and links to busybox for the applets that Merlin's busybox config_base turns on. A command outside that
// list is not found, and the run fails.
if (busyboxPath && dashPath) {
  describe("router version with the applets of Merlin only", () => {
    test("install, on, off, sources, status and uninstall work with only those applets", async () => {
      const probe = await mkdtemp(join(tmpdir(), "provrt-bin-"));
      made.push(probe);
      for (const applet of ROUTER_APPLETS) await symlink(busyboxPath, join(probe, applet));
      const rt = await router([dashPath], { install: false, path: probe });
      await symlink(join(rt.bin, "nvram"), join(probe, "nvram"));
      // The fake nvram sets its own PATH, so it does not need the applets.
      const done = await rt.install();
      expect(done.err).toBe("");
      expect(done.code).toBe(0);

      for (const command of ["off", "on", "sources 10.0.0.4", "status", "uninstall"]) {
        const result = await rt.run(command);
        expect(result.err, command).toBe("");
        expect(result.code, command).toBe(0);
      }
    });
  });
}
