import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionScript } from "../src/sshprovision";

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
