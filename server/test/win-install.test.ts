import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// deploy/windows/install.ps1 only runs on Windows. -NoService puts the files in place. Run these tests in an elevated
// prompt: the installer sets a restricted ACL on the bin folder, and a non-admin owner then cannot write into it.
// The old-layout reinstall needs a registered service, so only the text checks cover it.
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
    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-NoClient", "-ClientRegistryKey", "HKCU:\\Software\\claude-rc-unused", "-Binary", over.binary ?? bin, "-WinSW", winsw,
      "-InstallDir", join(dir, "app"), "-DataDir", join(dir, "data"), ...extra],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe.skipIf(!windows)("install.ps1 -NoService", () => {
  test("puts the binary, WinSW, the definition and a new config in place", async () => {
    const r = await install(["-Account", "TESTPC\\svcuser"].slice(0, 0));
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "app", "service", "claude-rc-launcher.exe"), "utf8")).toBe("MZ fake node binary");
    expect(await readFile(join(dir, "app", "service", "claude-rc-launcher-svc.exe"), "utf8")).toBe("MZ fake winsw");
    expect(await readFile(join(dir, "app", "service", "claude-rc-launcher-run.ps1"), "utf8")).toContain("update-pending.json");
    const xml = await readFile(join(dir, "app", "service", "claude-rc-launcher-svc.xml"), "utf8");
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
    expect(await readFile(join(dir, "app", "service", "claude-rc-launcher.exe"), "utf8")).toBe("MZ newer binary");
  });

  test("a file that is not a Windows executable is refused and nothing is installed", async () => {
    const html = join(dir, "error-page.exe");
    await writeFile(html, "<html>404</html>");
    const r = await install([], { binary: html });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is not a Windows executable");
    expect(await Bun.file(join(dir, "app", "service", "claude-rc-launcher.exe")).exists()).toBe(false);
  });

  test("a built-in service account is refused", async () => {
    const r = await install(["-Account", "NT AUTHORITY\\SYSTEM"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("must run as a user account");
  });

  test("a bad release tag is refused before any download", async () => {
    const p = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-Release", "not-a-tag", "-WinSW", winsw,
        "-InstallDir", join(dir, "app"), "-DataDir", join(dir, "data")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).not.toBe(0);
    expect(err).toContain("invalid release tag");
  });
});

// PowerShell is not available on every machine that runs these tests, so the layout and the registry value are also checked by text.
describe("install.ps1: the layout and the client registry value (text checks)", () => {
  let script: string;
  beforeEach(async () => { script = await readFile(SCRIPT, "utf8"); });

  test("the registry file is gone: no -RegistryDir, no -ClientDir parameter, no claude-rc-registry", () => {
    expect(script).not.toContain("$RegistryDir");
    expect(script).not.toContain("claude-rc-registry");
    expect(script).not.toMatch(/\[string\]\$ClientDir\b/);
    expect(script).not.toContain("icacls.exe $RegistryDir");
    expect(script).not.toContain("Test-TrustedOwner");
    expect(script).not.toContain("Set-AdminOwner");
    expect(script).not.toContain("Test-ReparsePoint");
  });

  test("-InstallDir defaults to Program Files\\claude-rc, and bin and service live under it", () => {
    expect(script).toContain("[string]$InstallDir = (Join-Path $env:ProgramFiles 'claude-rc')");
    expect(script).toContain("$ClientDir = Join-Path $InstallDir 'bin'");
    expect(script).toContain("$ServiceDir = Join-Path $InstallDir 'service'");
  });

  test("the key is -ClientRegistryKey, default HKLM:\\SOFTWARE\\claude-rc, and the value Client is set with Set-ItemProperty", () => {
    expect(script).toContain("[string]$ClientRegistryKey = 'HKLM:\\SOFTWARE\\claude-rc'");
    expect(script).toMatch(/Set-ItemProperty [^\n]*-Name Client\b/);
    expect(script).toContain("-Type String");
    expect(script).toContain("New-Item -Path $ClientRegistryKey -Force");
  });

  test("a failed registry write is a warning, and the step lives in the client branch that -NoClient skips", () => {
    const fn = script.slice(script.indexOf("function Register-Client"), script.indexOf("function Install-ClientAndPath"));
    expect(fn).toContain("try {");
    expect(fn).toContain("Write-Warning \"cannot write the client registry value");
    expect(script).toMatch(/Write-Host "Installed \$clientDest"\r?\n[\s\S]{0,400}Register-Client \$clientDest/);
    expect(script).toContain("if (-not $NoClient) { Install-ClientAndPath $clientSource }");
    expect(script.match(/Register-Client \$clientDest/g)!.length).toBe(1);
  });

  test("the Modify grant goes to the service folder only", () => {
    const grants = script.split(/\r?\n/).filter((l) => l.includes("icacls.exe") && l.includes("/grant "));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain("icacls.exe $ServiceDir /grant");
    expect(script).not.toMatch(/icacls\.exe \$InstallDir/);
    expect(script).not.toMatch(/icacls\.exe \$ClientDir \/grant /);
  });

  test("the old layout is recognised: no -InstallDir, an old service exe, and no new service folder", () => {
    expect(script).toContain("$PSBoundParameters.ContainsKey('InstallDir')");
    expect(script).toContain("claude-rc-launcher\\$Name-svc.exe");
    expect(script).toContain("-not (Test-Path -LiteralPath $ServiceDir)");
  });

  test("the old client is deleted and the old PATH entry is replaced", () => {
    expect(script).toContain("$oldClient = Join-Path $InstallDir 'claude-rc.exe'");
    expect(script).toContain("Remove-Item -LiteralPath $oldClient");
    expect(script).toContain("Remove-MachinePath $InstallDir $PathRegistryKey");
  });

  test("the old PATH entry is removed on every run of the PATH step, not only when the old exe was deleted", () => {
    expect(script).not.toContain("$migrate");
    expect(script).toMatch(/if \(\$dropOldPath -and \(Remove-MachinePath \$InstallDir \$PathRegistryKey\)\) \{/);
  });

  test("a locked old client only warns about the old client", () => {
    expect(script).toContain("could not remove the old client ${oldClient}");
  });

  test("-NoService writes no registry value unless a test key is given", () => {
    expect(script).toContain("$NoService -and -not $ClientOnly -and $ClientRegistryKey -eq $DefaultClientKey");
    expect(script).toContain("The client registry value was not written (-NoService).");
  });

  test("bin gets its own ACL: no inheritance, SYSTEM and Administrators full, Users read and execute", () => {
    expect(script).toContain("& icacls.exe $ClientDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX'");
    expect(script).toContain('throw "icacls failed on $ClientDir"');
  });

  test("the old layout applies only while the service is registered there", () => {
    expect(script).toContain("$RegisteredDir.TrimEnd('\\') -ieq (Split-Path -Parent $OldServiceExe).TrimEnd('\\')");
    expect(script).toContain("Get-CimInstance Win32_Service");
  });

  test("a service that runs from another folder stops the install", () => {
    expect(script).toContain("$runsFrom.TrimEnd('\\') -ine $ServiceDir.TrimEnd('\\')");
    expect(script).toContain("the service runs from $runsFrom, not from $ServiceDir. Give that folder as -InstallDir, or run -Uninstall first and delete it");
  });

  test("only the default parent folder, or one that holds the old client, leaves the PATH", () => {
    expect(script).toContain("$dropOldPath = $hadOldClient -or ($InstallDir.TrimEnd('\\') -ieq $DefaultInstallDir)");
    expect(script).toContain("if ($dropOldPath -and (Remove-MachinePath $InstallDir $PathRegistryKey))");
    expect(script).toContain("$DefaultInstallDir = (Join-Path $env:ProgramFiles 'claude-rc').TrimEnd('\\')");
    const un = script.slice(script.indexOf("if ($Uninstall) {"), script.indexOf("# ---- checks"));
    expect(un).toContain("$InstallDir.TrimEnd('\\') -ieq $DefaultInstallDir");
    expect(un).toContain("Join-Path $InstallDir 'claude-rc.exe'");
  });

  test("-Uninstall removes both PATH entries and says what it keeps", () => {
    const un = script.slice(script.indexOf("if ($Uninstall) {"), script.indexOf("# ---- checks"));
    expect(un).toContain("foreach ($dir in $oldDirs)");
    expect(un).toContain("Remove-MachinePath $dir $PathRegistryKey");
    expect(un).toContain("Kept:");
    expect(un).toContain("registry value");
  });
});

describe.skipIf(!windows)("install.ps1: the layout and the client registry value (Windows)", () => {
  const keyName = () => `claude-rc-regtest-${Math.random().toString(36).slice(2)}`;
  let clientKey: string;
  let pathKey: string;
  let client: string;
  const ps = async (command: string) => {
    const p = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { out: out.trim(), code };
  };
  const clientValue = async () => (await ps(`(Get-ItemProperty -LiteralPath '${clientKey}' -ErrorAction SilentlyContinue).Client`)).out;
  const pathValue = async () => (await ps(`(Get-Item -LiteralPath '${pathKey}').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`)).out;
  // Every run names -InstallDir. A run without it would use the REAL Program Files (an env override did not take effect on Windows).
  const run = async (extra: string[], opts: { env?: Record<string, string> } = {}) => {
    const args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-Binary", bin, "-WinSW", winsw, "-ClientBinary", client,
      "-DataDir", join(dir, "data"), "-ClientRegistryKey", clientKey, "-PathRegistryKey", pathKey, ...extra];
    if (!extra.includes("-InstallDir")) args.push("-InstallDir", join(dir, "app"));
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  const snapshot = async () => JSON.stringify([await clientValue(), await pathValue(), await readFile(join(dir, "app", "bin", "claude-rc.exe"), "utf8")]);

  beforeEach(async () => {
    const n = keyName();
    clientKey = `HKCU:\\Software\\${n}`;
    pathKey = `HKCU:\\Software\\${n}-path`;
    client = join(dir, "claude-rc-windows-x64.exe");
    await writeFile(client, "MZ client");
    await ps(`New-Item -Path '${pathKey}' -Force | Out-Null; Set-ItemProperty -LiteralPath '${pathKey}' -Name Path -Value 'C:\\Windows' -Type ExpandString`);
  });
  afterEach(async () => { await ps(`Remove-Item -LiteralPath '${clientKey}','${pathKey}' -Recurse -Force -ErrorAction SilentlyContinue`); });

  test("puts service and bin under the install folder, records the client, and a second run changes nothing", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "app", "service", "claude-rc-launcher.exe"), "utf8")).toBe("MZ fake node binary");
    expect(await readFile(join(dir, "app", "service", "claude-rc-launcher-svc.xml"), "utf8")).toContain("<id>claude-rc-launcher</id>");
    expect(await readFile(join(dir, "app", "bin", "claude-rc.exe"), "utf8")).toBe("MZ client");
    expect(await clientValue()).toBe(join(dir, "app", "bin", "claude-rc.exe"));
    const first = await snapshot();
    expect((await run([])).code).toBe(0);
    expect(await snapshot()).toBe(first);
  });

  test("the old client is deleted and the PATH entry moves from the install folder to bin", async () => {
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "claude-rc.exe"), "MZ old client");
    await ps(`Set-ItemProperty -LiteralPath '${pathKey}' -Name Path -Value 'C:\\Windows;${join(dir, "app")}' -Type ExpandString`);
    const r = await run(["-ClientOnly"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "app", "claude-rc.exe"))).toBe(false);
    expect(await pathValue()).toBe(`C:\\Windows;${join(dir, "app", "bin")}`);
  });

  test("-NoClient writes no value", async () => {
    expect((await run(["-NoClient"])).code).toBe(0);
    expect(await clientValue()).toBe("");
  });

  test("-ClientOnly writes bin, the PATH entry and the value, and no service folder", async () => {
    const r = await run(["-ClientOnly"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "app", "bin", "claude-rc.exe"))).toBe(true);
    expect(existsSync(join(dir, "app", "service"))).toBe(false);
    expect(await clientValue()).toBe(join(dir, "app", "bin", "claude-rc.exe"));
    expect(await pathValue()).toContain(join(dir, "app", "bin"));
  });

  test("a custom -InstallDir stays on the PATH when there is no old client", async () => {
    await ps(`Set-ItemProperty -LiteralPath '${pathKey}' -Name Path -Value 'C:\\Windows;${join(dir, "app")}' -Type ExpandString`);
    expect((await run(["-ClientOnly"])).code).toBe(0);
    expect(await pathValue()).toBe(`C:\\Windows;${join(dir, "app")};${join(dir, "app", "bin")}`);
  });

  test("bin never gets the Modify grant of the service account, even inside the old service folder", async () => {
    const old = join(dir, "claude-rc-launcher");
    const r = await run(["-InstallDir", old]);
    expect(r.code).toBe(0);
    // The service account here is the account that runs the test, and it can be an administrator or the owner (a CI
    // runner is both), so it can show full control on bin too. What must hold: bin has no Modify entry, and the service
    // folder has an entry for the account.
    const who = (await ps("[Security.Principal.WindowsIdentity]::GetCurrent().Name")).out;
    const entry = new RegExp(`${who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i");
    const bin = (await ps(`icacls '${join(old, "bin")}'`)).out;
    expect(bin).not.toMatch(/\(M\)/);
    expect(bin).toContain("(F)");
    expect((await ps(`icacls '${join(old, "service")}'`)).out).toMatch(entry);
  });

  test("a client path with a space is stored whole", async () => {
    const spaced = join(dir, "my apps", "claude rc");
    const r = await run(["-ClientOnly", "-InstallDir", spaced]);
    expect(r.code).toBe(0);
    expect(await clientValue()).toBe(join(spaced, "bin", "claude-rc.exe"));
  });
});
