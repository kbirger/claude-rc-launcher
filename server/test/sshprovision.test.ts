import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, mkdir, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deprovisionScript, provisionScript } from "../src/sshprovision";

const LINE = 'from="192.168.1.103",restrict ssh-ed25519 AAAAC3Nza claude-rc:nas';
const made: string[] = [];

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prov-"));
  made.push(dir);
  return dir;
}

async function run(script: string, dir: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["sh", "-s"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: dir },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

const keys = (dir: string) => join(dir, ".ssh", "authorized_keys");
const mode = async (path: string) => (await stat(path)).mode & 0o777;

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("provisionScript", () => {
  test("the sh script adds the line once when it runs twice", async () => {
    const dir = await home();
    const { script, shell } = provisionScript("linux", LINE);
    expect(shell).toBe("sh");
    expect(await run(script, dir)).toEqual({ code: 0, out: "" });
    expect(await run(script, dir)).toEqual({ code: 0, out: "" });
    expect(await readFile(keys(dir), "utf8")).toBe(`${LINE}\n`);
  });

  test("the sh script sets mode 700 on .ssh and 600 on the file", async () => {
    const dir = await home();
    await run(provisionScript("linux", LINE).script, dir);
    expect(await mode(join(dir, ".ssh"))).toBe(0o700);
    expect(await mode(keys(dir))).toBe(0o600);
  });

  test("the sh script keeps the other keys in the file", async () => {
    const dir = await home();
    await mkdir(join(dir, ".ssh"), { mode: 0o755 });
    // The old file has no newline at its end and loose permissions.
    await writeFile(keys(dir), "ssh-rsa OLD one\nssh-rsa OLD two", { mode: 0o644 });
    await run(provisionScript("linux", LINE).script, dir);
    expect(await readFile(keys(dir), "utf8")).toBe(`ssh-rsa OLD one\nssh-rsa OLD two\n${LINE}\n`);
    expect(await mode(join(dir, ".ssh"))).toBe(0o700);
    expect(await mode(keys(dir))).toBe(0o600);
  });

  test("a line with a single quote or a dollar sign arrives unchanged", async () => {
    const dir = await home();
    const marker = join(dir, "pwned");
    const nasty = `a'b $HOME \`touch ${marker}\` "q" $(touch ${marker}) ';touch ${marker};' end`;
    const { script } = provisionScript("linux", nasty);
    expect(await run(script, dir)).toEqual({ code: 0, out: "" });
    expect(await readFile(keys(dir), "utf8")).toBe(`${nasty}\n`);
    expect(await stat(marker).catch(() => null)).toBeNull();
  });

  test("the synology script removes group and other write from the home folder", async () => {
    const dir = await home();
    await chmod(dir, 0o777);
    const { script } = provisionScript("synology", LINE);
    expect(await run(script, dir)).toEqual({ code: 0, out: "" });
    expect((await mode(dir)) & 0o022).toBe(0);
    expect(await readFile(keys(dir), "utf8")).toBe(`${LINE}\n`);
  });

  test("the dropbear script writes the same file as the linux script", async () => {
    const linux = await home();
    const dropbear = await home();
    await run(provisionScript("linux", LINE).script, linux);
    await run(provisionScript("dropbear", LINE).script, dropbear);
    expect(await readFile(keys(dropbear), "utf8")).toBe(await readFile(keys(linux), "utf8"));
    expect(await mode(keys(dropbear))).toBe(0o600);
  });

  test("the windows script names administrators_authorized_keys and icacls", () => {
    const { shell, script } = provisionScript("windows", LINE);
    expect(shell).toBe("powershell");
    expect(script).toContain("administrators_authorized_keys");
    expect(script).toContain("icacls");
    expect(script).toContain(".ssh");
  });

  const hasPwsh = Bun.which("pwsh") !== null;
  test.skipIf(!hasPwsh)("the windows script parses as PowerShell", async () => {
    const nasty = `a'b $x \`n "q" ${LINE}`;

    for (const options of [{}, { account: "dev.user-1" }]) {
      const { script } = provisionScript("windows", nasty, options);
      const proc = Bun.spawn(
        [
          "pwsh",
          "-NoProfile",
          "-Command",
          "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit ($e.Count)",
        ],
        { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      expect({ code: await proc.exited, out }).toEqual({ code: 0, out: "" });
    }
  });

  /** Run a script the way Tasks 9 and 13 deliver it: on stdin, `-Command -`. */
  async function runPwsh(
    script: string,
    env: Record<string, string>,
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: "/tmp", TERM: "dumb", ...env },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }

  test.skipIf(!hasPwsh)("a typographic single quote cannot break out of the PowerShell string", async () => {
    const nasty = 'x\u2019; Write-Output INJECTED; \u2018 y\u201A \u201B z\' $x `n "q"';
    // The full script needs Windows, so run only its assignment of the line and print the value.
    const { script } = provisionScript("windows", nasty, { account: nasty });
    const assignments = script.split("\n").filter((text) => /^\s*\$(line|sid) = /.test(text));
    expect(assignments.length).toBeGreaterThan(0);
    const probe = `${assignments[0].trim()}\n[Console]::Out.Write($line)\n`;
    const result = await runPwsh(probe, {});
    expect(result).toEqual({ code: 0, out: nasty, err: "" });
    // The account name is quoted by the same function.
    expect(script).not.toContain("INJECTED; \u2018 y\u201A \u201B z' $x");
  });

  test.skipIf(!hasPwsh)("a failing step gives a non-zero exit code in stdin mode", async () => {
    for (const options of [{}, { account: "nobody-here" }]) {
      const { script } = provisionScript("windows", LINE, options);
      const result = await runPwsh(script, {});
      expect(result.code).not.toBe(0);
      expect(result.err).not.toBe("");
    }
  });

  test("the windows script ends with a blank line and wraps its body in try and catch", () => {
    const { script } = provisionScript("windows", LINE);
    expect(script.endsWith("\n\n")).toBe(true);
    expect(script).toContain("try {");
    expect(script).toContain("exit 1");
  });

  test("the windows script uses the profile of the current user when there is no account", () => {
    const { script } = provisionScript("windows", LINE);
    expect(script).toContain("$env:USERPROFILE");
    expect(script).not.toContain("ProfileList");
  });

  test("the windows script resolves the profile of the account by SID and checks the Administrators group", () => {
    const { script } = provisionScript("windows", LINE, { account: "dev.user-1" });
    expect(script).toContain("'dev.user-1'");
    expect(script).toContain("ProfileList");
    expect(script).toContain("ProfileImagePath");
    expect(script).toContain("S-1-5-32-544");
    expect(script).toContain("administrators_authorized_keys");
    expect(script).not.toContain("Split-Path -Parent $env:USERPROFILE");
  });
});

describe("deprovisionScript", () => {
  const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIAAA";
  const OTHER = "AAAAC3NzaC1lZDI1NTE5AAAAIBBB";
  const mine = `from="10.0.0.1",restrict ssh-ed25519 ${BLOB} claude-rc:nas`;
  const mineOld = `ssh-ed25519 ${BLOB} claude-rc:nas`;
  const otherId = `ssh-ed25519 ${BLOB} claude-rc:other`;
  const commentOnly = `ssh-ed25519 ${OTHER} claude-rc:nas`;
  const blobOnly = `ssh-ed25519 ${BLOB} laptop`;
  const inOptions = `command="echo ${BLOB} y" ssh-ed25519 ${OTHER} claude-rc:nas`;
  const script = deprovisionScript("linux", BLOB, "nas").script;
  const sshFiles = async (dir: string) =>
    (await readdir(join(dir, ".ssh"))).filter((name) => name !== ".claude-rc.lock");

  async function runWith(text: string, dir: string, path: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["sh", "-s"], {
      stdin: new Blob([text]),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: path, HOME: dir },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: out + err };
  }

  async function setFile(dir: string, text: string, fileMode = 0o600): Promise<void> {
    await mkdir(join(dir, ".ssh"), { mode: 0o700 });
    await writeFile(keys(dir), text, { mode: fileMode });
    await chmod(keys(dir), fileMode);
  }

  test("it removes exactly the lines with the blob and the comment, and prints removed", async () => {
    const dir = await home();
    await setFile(
      dir,
      ["ssh-rsa OLD one", mine, commentOnly, blobOnly, inOptions, otherId, mineOld, "ssh-rsa OLD two", ""].join("\n"),
    );
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(dir), "utf8")).toBe(
      ["ssh-rsa OLD one", commentOnly, blobOnly, inOptions, otherId, "ssh-rsa OLD two", ""].join("\n"),
    );
  });

  test("it keeps the mode of the file and is safe to run twice", async () => {
    const dir = await home();
    await setFile(dir, `${mine}\nssh-rsa KEEP x\n`, 0o640);
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await mode(keys(dir))).toBe(0o640);
    expect(await run(script, dir)).toEqual({ code: 0, out: "not-found\n" });
    expect(await readFile(keys(dir), "utf8")).toBe("ssh-rsa KEEP x\n");
    expect(await mode(keys(dir))).toBe(0o640);
  });

  test("it works on a file without a newline at the end and leaves no temporary file", async () => {
    const dir = await home();
    await setFile(dir, `ssh-rsa KEEP x\n${mine}`);
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(dir), "utf8")).toBe("ssh-rsa KEEP x\n");
    expect(await sshFiles(dir)).toEqual(["authorized_keys"]);
  });

  test("it prints not-found and changes nothing when no line matches", async () => {
    const dir = await home();
    const text = [commentOnly, blobOnly, otherId, ""].join("\n");
    await setFile(dir, text);
    expect(await run(script, dir)).toEqual({ code: 0, out: "not-found\n" });
    expect(await readFile(keys(dir), "utf8")).toBe(text);
  });

  test("it prints not-found for a missing file and does not create one", async () => {
    const dir = await home();
    expect(await run(script, dir)).toEqual({ code: 0, out: "not-found\n" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("it removes the last line and leaves an empty file", async () => {
    const dir = await home();
    await setFile(dir, `${mine}\n`);
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(dir), "utf8")).toBe("");
  });

  test("it exits non-zero, keeps the file and does not truncate it when no temporary file can be made", async () => {
    const dir = await home();
    const text = `${mine}\nssh-rsa KEEP x\n`;
    await setFile(dir, text);
    const fake = await home();
    await writeFile(join(fake, "cp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const real = process.env.PATH ?? "";
    const result = await runWith(script, dir, `${fake}:${real}`);
    expect(result.code).not.toBe(0);
    expect(await readFile(keys(dir), "utf8")).toBe(text);
    expect(await sshFiles(dir)).toEqual(["authorized_keys"]);
  });

  test("it refuses a symbolic link as the file and as the folder, and changes nothing", async () => {
    const dir = await home();
    const elsewhere = await home();
    await writeFile(join(elsewhere, "real"), `${mine}\n`);
    await mkdir(join(dir, ".ssh"), { mode: 0o700 });
    await symlink(join(elsewhere, "real"), keys(dir));
    const linked = await run(script, dir);
    expect(linked.code).not.toBe(0);
    expect(linked.out).toContain("symbolic link");
    expect((await lstat(keys(dir))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(elsewhere, "real"), "utf8")).toBe(`${mine}\n`);

    const other = await home();
    await mkdir(join(elsewhere, "folder"));
    await writeFile(join(elsewhere, "folder", "authorized_keys"), `${mine}\n`);
    await symlink(join(elsewhere, "folder"), join(other, ".ssh"));
    const folder = await run(script, other);
    expect(folder.code).not.toBe(0);
    expect(folder.out).toContain("symbolic link");
    expect(await readFile(join(elsewhere, "folder", "authorized_keys"), "utf8")).toBe(`${mine}\n`);
  });

  test("it matches the structure of the line: type, blob, comment, and nothing else", async () => {
    const dir = await home();
    const kept = [
      inOptions,
      `ssh-ed25519 ${BLOB} claude-rc:nas-lan`,
      `ssh-ed25519 ${BLOB}xyz claude-rc:nas`,
      `ssh-ed25519 x${BLOB} claude-rc:nas`,
      `# ssh-ed25519 ${BLOB} claude-rc:nas`,
      `#ssh-ed25519 ${BLOB} claude-rc:nas`,
      `ssh-rsa ${BLOB} claude-rc:nas`,
      `${BLOB} claude-rc:nas`,
    ];
    await setFile(dir, [...kept, `  \t ssh-ed25519\t${BLOB}  claude-rc:nas`, ""].join("\n"));
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(dir), "utf8")).toBe([...kept, ""].join("\n"));
  });

  test("it handles CRLF lines and keeps the original bytes of the kept lines", async () => {
    const dir = await home();
    await setFile(dir, `ssh-rsa A one\r\n${mine}\r\n${inOptions}\r\nssh-rsa B two\r\n`);
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(dir), "utf8")).toBe(`ssh-rsa A one\r\n${inOptions}\r\nssh-rsa B two\r\n`);
  });

  test("it keeps a missing final newline, and does not add one when the last line goes", async () => {
    const dir = await home();
    await setFile(dir, `ssh-rsa A one\n${mine}\nssh-rsa B two`);
    expect(await run(script, dir)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(dir), "utf8")).toBe("ssh-rsa A one\nssh-rsa B two");

    const other = await home();
    await setFile(other, `ssh-rsa A one\n${mine}`);
    expect(await run(script, other)).toEqual({ code: 0, out: "removed\n" });
    expect(await readFile(keys(other), "utf8")).toBe("ssh-rsa A one\n");
  });

  test("the sh scripts take a lock with flock when it exists", () => {
    expect(script).toContain("flock");
    expect(script).toContain(".claude-rc.lock");
    expect(provisionScript("linux", LINE).script).toContain("flock");
  });

  test("a hostile id and blob arrive as data and remove nothing else", async () => {
    const hostile = ["a'b", "$(touch PWNED)", "`touch PWNED`", "a\nb", "it\u2019s", "\\n", '"; touch PWNED; "'];

    for (const text of hostile) {
      const dir = await home();
      await setFile(dir, `${mine}\n${blobOnly}\n${inOptions}\n`);

      for (const [blob, id] of [
        [text, "nas"],
        [BLOB, text],
      ] as const) {
        const out = await run(deprovisionScript("linux", blob, id).script, dir);
        expect(out.code).toBe(0);
        expect(out.out).toBe("not-found\n");
      }

      expect(await readFile(keys(dir), "utf8")).toBe(`${mine}\n${blobOnly}\n${inOptions}\n`);
      expect(await readdir(dir)).toEqual([".ssh"]);
      expect(await sshFiles(dir)).toEqual(["authorized_keys"]);
    }
  });

  test("the windows script quotes its values, wraps the body in try and catch and ends with a blank line", () => {
    const { shell, script: ps } = deprovisionScript("windows", "AAAA\u2019'x", "n\u2018'y", { account: "o\u2019'z" });
    expect(shell).toBe("powershell");
    expect(ps).toContain("'AAAA\u2019\u2019''x'");
    expect(ps).toContain("'claude-rc:n\u2018\u2018''y'");
    expect(ps).toContain("'o\u2019\u2019''z'");
    expect(ps).toContain("catch");
    expect(ps).toContain("exit 1");
    expect(ps).toContain("administrators_authorized_keys");
    expect(ps).toContain("-ceq 'ssh-ed25519'");
    expect(ps).toContain("[IO.File]::Replace");
    expect(ps).toContain("icacls.exe");
    expect(ps).not.toContain("Set-Acl");
    expect(ps).not.toContain("WriteAllText($file");
    expect(ps.endsWith("\n\n")).toBe(true);
  });

  test.skipIf(Bun.which("pwsh") === null)("the windows script parses under pwsh", async () => {
    const dir = await home();
    const file = join(dir, "check.ps1");
    await writeFile(file, deprovisionScript("windows", BLOB, "nas", { account: "alice" }).script);
    const parse =
      "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS_FILE, [ref]$null, [ref]$e); if ($e.Count -gt 0) { $e | ForEach-Object { $_.ToString() }; exit 1 }";
    const proc = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", parse], {
      env: { ...process.env, PS_FILE: file },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code: await proc.exited, out: out + err }).toEqual({ code: 0, out: "" });
  });
});
