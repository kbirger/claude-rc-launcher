import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// deploy/windows/install.ps1 only runs on Windows. -NoService puts the files in place and needs no admin rights.
const SCRIPT = resolve(import.meta.dir, "../../deploy/windows/install.ps1");
const windows = process.platform === "win32";

let dir: string;
let bin: string;
let winsw: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "winstall-"));
  bin = join(dir, "fake-node.exe");
  winsw = join(dir, "fake-winsw.exe");
  await writeFile(bin, "MZ fake node binary");
  await writeFile(winsw, "MZ fake winsw");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function install(extra: string[] = [], over: { binary?: string } = {}) {
  const p = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-NoClient", "-Binary", over.binary ?? bin, "-WinSW", winsw,
      "-InstallDir", join(dir, "bin"), "-DataDir", join(dir, "data"), ...extra],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe.skipIf(!windows)("install.ps1 -NoService", () => {
  test("puts the binary, WinSW, the definition and a new config in place", async () => {
    const r = await install(["-Account", "TESTPC\\svcuser"].slice(0, 0));
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "bin", "claude-rc-launcher.exe"), "utf8")).toBe("MZ fake node binary");
    expect(await readFile(join(dir, "bin", "claude-rc-launcher-svc.exe"), "utf8")).toBe("MZ fake winsw");
    expect(await readFile(join(dir, "bin", "claude-rc-launcher-run.ps1"), "utf8")).toContain("update-pending.json");
    const xml = await readFile(join(dir, "bin", "claude-rc-launcher-svc.xml"), "utf8");
    expect(xml).toContain("<id>claude-rc-launcher</id>");
    expect(xml).toContain("<executable>powershell.exe</executable>");
    expect(xml).toContain(`-Config "${join(dir, "data", "config.toml")}" -DataDir "${join(dir, "data")}"`);
    expect(xml).toContain('-File "%BASE%\\claude-rc-launcher-run.ps1" -Exe "%BASE%\\claude-rc-launcher.exe"');
    expect(xml).toContain(`<logpath>${join(dir, "data", "logs")}</logpath>`);
    expect(xml).not.toMatch(/@[A-Z_]+@/); // every token was replaced
    const conf = await readFile(join(dir, "data", "config.toml"), "utf8");
    expect(conf).toContain('mode = "node"');
    expect(conf).not.toContain("__SERVICE_USER__");
    expect(conf).toMatch(/^service_user = "[^"\\]+"$/m); // the short account name, without the domain
  });

  test("an existing config.toml is never changed, and the binary is replaced on a second run", async () => {
    await install();
    const conf = join(dir, "data", "config.toml");
    await writeFile(conf, 'mode = "node"\n# MY EDIT\n');
    await writeFile(bin, "MZ newer binary");
    const r = await install();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Keeping existing");
    expect(await readFile(conf, "utf8")).toBe('mode = "node"\n# MY EDIT\n');
    expect(await readFile(join(dir, "bin", "claude-rc-launcher.exe"), "utf8")).toBe("MZ newer binary");
  });

  test("a file that is not a Windows executable is refused and nothing is installed", async () => {
    const html = join(dir, "error-page.exe");
    await writeFile(html, "<html>404</html>");
    const r = await install([], { binary: html });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is not a Windows executable");
    expect(await Bun.file(join(dir, "bin", "claude-rc-launcher.exe")).exists()).toBe(false);
  });

  test("a built-in service account is refused", async () => {
    const r = await install(["-Account", "NT AUTHORITY\\SYSTEM"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("must run as a user account");
  });

  test("a bad release tag is refused before any download", async () => {
    const p = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-Release", "not-a-tag", "-WinSW", winsw,
        "-InstallDir", join(dir, "bin"), "-DataDir", join(dir, "data")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).not.toBe(0);
    expect(err).toContain("invalid release tag");
  });
});

// PowerShell is not available on every machine that runs these tests, so the registry step is also checked by text.
describe("install.ps1: the client registry (text checks)", () => {
  let script: string;
  beforeEach(async () => { script = await readFile(SCRIPT, "utf8"); });

  test("the registry folder is claude-rc-registry under ProgramData, overridable with -RegistryDir, and not the data folder", () => {
    expect(script).toContain("[string]$RegistryDir = (Join-Path $env:ProgramData 'claude-rc-registry')");
    expect(script).toContain("[string]$DataDir = (Join-Path $env:ProgramData 'claude-rc-launcher')");
    expect(script).not.toContain("$RegistryDir = (Join-Path $env:ProgramData 'claude-rc-launcher')");
  });

  test("the folder and the file are locked on every run: SYSTEM and Administrators full control, Users read only", () => {
    expect(script).toContain("& icacls.exe $RegistryDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)R'");
    expect(script).toContain("& icacls.exe $file /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-32-545:R'");
    expect(script).toContain("icacls failed on $RegistryDir");
    expect(script).toContain("icacls failed on $file");
  });

  test("a registry folder that equals the data, install or client folder is refused with a warning", () => {
    expect(script).toContain("foreach ($own in @($DataDir, $InstallDir, $ClientDir))");
    expect(script).toContain("[IO.Path]::GetFullPath($RegistryDir).TrimEnd('\\')");
    expect(script).toContain("-ieq [IO.Path]::GetFullPath($own).TrimEnd('\\')");
    expect(script).toContain("must be a folder of its own");
  });

  test("a reparse point is skipped with a warning, never followed", () => {
    expect(script).toContain("(Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint");
    expect(script).toContain("if (Test-ReparsePoint $RegistryDir) { Write-Warning");
    expect(script).toContain("if (Test-ReparsePoint $file) { Write-Warning");
  });

  test("the owner of an existing folder and file must be Administrators or SYSTEM", () => {
    expect(script).toContain("(Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier])");
    expect(script).toContain("@('S-1-5-32-544', 'S-1-5-18') -contains $sid.Value");
    expect(script).toContain("if (-not (Test-TrustedOwner $RegistryDir)) { $untrusted = $true }");
    expect(script).toContain("if (-not (Test-TrustedOwner $file)) { $untrusted = $true }");
  });

  test("the folder and the file are always owned by Administrators, set before the ACL", () => {
    expect(script).toContain("& icacls.exe $Path /setowner '*S-1-5-32-544'");
    expect(script).toContain("icacls /setowner failed on $Path");
    expect(script).toMatch(/Set-AdminOwner \$RegistryDir\r?\n\s+& icacls\.exe \$RegistryDir \/inheritance:r/);
    expect(script).toMatch(/Set-AdminOwner \$file\r?\n\s+& icacls\.exe \$file \/inheritance:r/);
  });

  test("a registry that someone else owned is replaced and its old content is discarded", () => {
    expect(script).toContain("belonged to someone else: it was taken over and its old content was discarded");
    expect(script).toContain("if ($untrusted -and $fileExists) {");
    expect(script).toMatch(/Remove-Item -LiteralPath \$file -Force\r?\n\s+\$fileExists = \$false/);
  });

  test("the path guard runs inside the try, so a bad path only warns", () => {
    const fn = script.slice(script.indexOf("function Register-Client"));
    expect(fn.indexOf("try {")).toBeLessThan(fn.indexOf("[IO.Path]::GetFullPath($RegistryDir)"));
    expect(fn.indexOf("[IO.Path]::GetFullPath($RegistryDir)")).toBeLessThan(fn.indexOf("} catch {"));
  });

  test("it adds `client <path>` once: a case-insensitive exact-line check, UTF-8 without BOM", () => {
    expect(script).toContain('$line = "client $ClientPath"');
    expect(script).toContain("$_.TrimEnd(\"`r\") -ieq $line");
    expect(script).toContain("New-Object Text.UTF8Encoding($false)");
  });

  test("a failure is a warning, and the step lives in the client branch that -NoClient skips", () => {
    expect(script).toContain("Write-Warning \"cannot write the client registry");
    expect(script).toMatch(/Write-Host "Installed \$clientDest"\r?\n\s+Register-Client \$clientDest/);
    expect(script).toContain("if (-not $NoClient) { Install-ClientAndPath $clientSource }");
    expect(script.match(/Register-Client \$clientDest/g)!.length).toBe(1);
  });
});

describe.skipIf(!windows)("install.ps1: the client registry (Windows)", () => {
  test("writes `client <ClientDir>\\claude-rc.exe` once, even on a second run, and -NoClient writes nothing", async () => {
    const reg = join(dir, "registry");
    const clientDir = join(dir, "clients");
    const client = join(dir, "claude-rc-windows-x64.exe");
    await writeFile(client, "MZ client");
    const run = (extra: string[]) => Bun.spawn(
      ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-Binary", bin, "-WinSW", winsw, "-ClientBinary", client,
        "-InstallDir", join(dir, "bin"), "-DataDir", join(dir, "data"), "-ClientDir", clientDir, "-RegistryDir", reg, "-PathRegistryKey", "HKCU:\\Software\\claude-rc-regtest", ...extra],
      { stdout: "pipe", stderr: "pipe" }).exited;
    expect(await run(["-NoClient"])).toBe(0);
    expect(await Bun.file(join(reg, "installs")).exists()).toBe(false);
    expect(await run([])).toBe(0);
    expect(await run([])).toBe(0);
    expect((await readFile(join(reg, "installs"), "utf8")).split(/\r?\n/).filter(Boolean)).toEqual([`client ${join(clientDir, "claude-rc.exe")}`]);
  });
});
