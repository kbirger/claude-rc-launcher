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
    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-NoService", "-Binary", over.binary ?? bin, "-WinSW", winsw,
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
    const xml = await readFile(join(dir, "bin", "claude-rc-launcher-svc.xml"), "utf8");
    expect(xml).toContain("<id>claude-rc-launcher</id>");
    expect(xml).toContain(`<arguments>--config "${join(dir, "data", "config.toml")}"</arguments>`);
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
