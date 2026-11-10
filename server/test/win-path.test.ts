import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The client install and the PATH update of deploy/windows/install.ps1. Windows only.
// The machine PATH is never touched: every test gives -PathRegistryKey a throwaway key under HKCU.
const SCRIPT = resolve(import.meta.dir, "../../deploy/windows/install.ps1");
const windows = process.platform === "win32";
const MACHINE_KEY = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

const isAdmin =
  windows &&
  // The enum, not the string 'Administrator': IsInRole(string) looks for a group with that exact name, which does not
  // exist (the group is "Administrators"), so it answers False even in an elevated shell.
  Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"])
    .stdout.toString().trim() !== "False"; // fail closed: anything but a clear "not an administrator" skips the test

let dir: string;
let key: string; // HKCU:\Software\...
let regPath: string; // HKCU\Software\... (reg.exe form)
let client: string;
let installDir: string;
let clientDir: string; // <installDir>\bin

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
const reg = (...a: string[]) => run(["reg.exe", ...a]);
async function setPath(value: string, type = "REG_EXPAND_SZ") {
  expect((await reg("add", regPath, "/v", "Path", "/t", type, "/d", value, "/f")).code).toBe(0);
}
async function readPath(): Promise<{ type: string; value: string }> {
  const r = await reg("query", regPath, "/v", "Path");
  const m = /Path\s+(REG_\w+)\s+(.*)\r?\n/.exec(r.out);
  if (!m) throw new Error(`cannot read the test key: ${r.out}${r.err}`);
  return { type: m[1]!, value: m[2]!.trim() };
}
async function install(extra: string[] = [], opts: { key?: string; client?: boolean } = {}) {
  const args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-Binary", join(dir, "node.exe"), "-WinSW", join(dir, "winsw.exe"),
    "-InstallDir", installDir, "-DataDir", join(dir, "data"), "-ClientRegistryKey", `${key}-client`, "-PathRegistryKey", opts.key ?? key];
  if (opts.client !== false) args.push("-ClientBinary", client);
  return run([...args, ...extra]);
}

beforeEach(async () => {
  if (!windows) return;
  dir = await mkdtemp(join(tmpdir(), "winpath-"));
  installDir = join(dir, "claude rc"); // with a space, as Program Files has
  clientDir = join(installDir, "bin");
  client = join(dir, "claude-rc-windows-x64.exe");
  await Promise.all([writeFile(join(dir, "node.exe"), "MZ node"), writeFile(join(dir, "winsw.exe"), "MZ winsw"), writeFile(client, "MZ client")]);
  const name = `claude-rc-pathtest-${Math.random().toString(36).slice(2)}`;
  key = `HKCU:\\Software\\${name}`;
  regPath = `HKCU\\Software\\${name}`;
  await setPath("C:\\Windows;%SystemRoot%\\system32;C:\\Tools");
});
afterEach(async () => {
  if (!windows) return;
  await reg("delete", regPath, "/f");
  await reg("delete", `${regPath}-client`, "/f");
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!windows)("install.ps1: the claude-rc client and the PATH", () => {
  test("the test's own administrator check agrees with the token's integrity level", async () => {
    // The tests below that point at the real machine PATH are skipped when this says "administrator", so it must be right.
    const groups = (await run(["whoami.exe", "/groups"])).out;
    const high = groups.includes("High Mandatory Level");
    expect(isAdmin).toBe(high);
  });

  test("installs claude-rc.exe in its own folder and appends that folder to the PATH", async () => {
    const r = await install();
    expect(r.code).toBe(0);
    expect(await readFile(join(clientDir, "claude-rc.exe"), "utf8")).toBe("MZ client");
    expect(existsSync(join(installDir, "service", "claude-rc.exe"))).toBe(false); // not in the node's folder
    const p = await readPath();
    expect(p.type).toBe("REG_EXPAND_SZ");
    expect(p.value).toBe(`C:\\Windows;%SystemRoot%\\system32;C:\\Tools;${clientDir}`); // the old entries are unchanged, unexpanded
    expect(r.out).toContain("Open a new terminal");
  });

  test("a second run does not add the folder again", async () => {
    await install();
    const before = await readPath();
    const r = await install();
    expect(r.code).toBe(0);
    expect(await readPath()).toEqual(before);
    expect(r.out).toContain("already on the machine PATH");
  });

  test("an entry that differs only in case or in a final backslash counts as present", async () => {
    await setPath(`C:\\Windows;${clientDir.toUpperCase()}\\`);
    const r = await install();
    expect(r.code).toBe(0);
    expect((await readPath()).value).toBe(`C:\\Windows;${clientDir.toUpperCase()}\\`);
  });

  test("an empty PATH becomes just the folder", async () => {
    await setPath("");
    await install();
    expect((await readPath()).value).toBe(clientDir);
  });

  test("-NoClient installs no client and leaves the PATH alone", async () => {
    const before = await readPath();
    const r = await install(["-NoClient"], { client: false });
    expect(r.code).toBe(0);
    expect(await readPath()).toEqual(before);
    expect(existsSync(clientDir)).toBe(false);
  });

  test("a client that is not a Windows executable is refused and nothing changes", async () => {
    await writeFile(client, "<html>404</html>");
    const before = await readPath();
    const r = await install();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not a Windows executable");
    expect(await readPath()).toEqual(before);
    expect(existsSync(join(installDir, "service", "claude-rc-launcher.exe"))).toBe(false);
  });

  test("-ClientOnly installs only the client and the PATH entry: no node, no service files", async () => {
    const r = await install(["-ClientOnly"]);
    expect(r.code).toBe(0);
    expect(await readFile(join(clientDir, "claude-rc.exe"), "utf8")).toBe("MZ client");
    expect(existsSync(join(installDir, "service"))).toBe(false);
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect((await readPath()).value).toBe(`C:\\Windows;%SystemRoot%\\system32;C:\\Tools;${clientDir}`);
    expect((await install(["-ClientOnly"])).out).toContain("already on the machine PATH");
  });

  test("-ClientOnly with a client that is not a Windows executable changes nothing", async () => {
    await writeFile(client, "<html>404</html>");
    const before = await readPath();
    const r = await install(["-ClientOnly"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not a Windows executable");
    expect(await readPath()).toEqual(before);
  });

  test("-ClientOnly and -NoClient together are refused", async () => {
    const r = await install(["-ClientOnly", "-NoClient"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cannot be used together");
  });

  test("-ClientOnly with a bad release tag is refused before any download", async () => {
    const r = await install(["-ClientOnly", "-Release", "latest"], { client: false });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("invalid release tag");
  });

  // Also points the script at the real machine key, so it too runs only without administrator rights.
  test.skipIf(isAdmin)("-ClientOnly on the real machine PATH needs an elevated PowerShell", async () => {
    const read = async () => (await run(["powershell.exe", "-NoProfile", "-Command",
      `(Get-Item -LiteralPath '${MACHINE_KEY}').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`])).out;
    const before = await read();
    const r = await install(["-ClientOnly"], { key: MACHINE_KEY });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("elevated PowerShell");
    expect(await read()).toBe(before);
    expect(existsSync(join(clientDir, "claude-rc.exe"))).toBe(false);
  });

  // This test points the script at the REAL machine key. It runs only without administrator rights: if the guard under
  // test were broken, the write would then be refused instead of changing the system PATH. (Found the hard way: with
  // the guard removed, an elevated run of this test left a stray entry in the machine PATH.)
  test.skipIf(isAdmin)("with -NoService the real machine PATH is never changed", async () => {
    const read = async () => (await run(["powershell.exe", "-NoProfile", "-Command",
      `(Get-Item -LiteralPath '${MACHINE_KEY}').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`])).out;
    const before = await read();
    const r = await install([], { key: MACHINE_KEY });
    expect(r.code).toBe(0);
    expect(r.out).toContain("The machine PATH was not changed (-NoService)");
    expect(await read()).toBe(before);
    expect(existsSync(join(clientDir, "claude-rc.exe"))).toBe(true); // the client itself is still installed
  });

  test("the remove step takes the folder off the PATH and keeps the other entries", async () => {
    await install();
    // Run the script's own functions (not the whole script, which would touch the real service) against the test key.
    const script = `
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replaceAll("'", "''")}', [ref]$null, [ref]$null)
      $names = 'Get-PathEntries','Set-PathEntries','Add-MachinePath','Remove-MachinePath'
      $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
      'first: ' + (Remove-MachinePath '${clientDir.replaceAll("'", "''")}' '${key}')
      'again: ' + (Remove-MachinePath '${clientDir.replaceAll("'", "''")}' '${key}')`;
    const r = await run(["powershell.exe", "-NoProfile", "-Command", script]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("first: True");
    expect(r.out).toContain("again: False");
    expect((await readPath()).value).toBe("C:\\Windows;%SystemRoot%\\system32;C:\\Tools");
    expect((await readPath()).type).toBe("REG_EXPAND_SZ");
  });
});
