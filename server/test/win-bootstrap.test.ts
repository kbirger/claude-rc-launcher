import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `irm <url> | iex` and a lone install.ps1: the script fetches the release zip, checks it, and hands over to the
// install.ps1 inside. A local HTTP server plays the release. Windows only. Nothing here touches the real machine PATH,
// the real services or the real Program Files: every run uses -NoService/-NoClient or a throwaway registry key.
const DEPLOY = resolve(import.meta.dir, "../../deploy/windows");
const SCRIPT = join(DEPLOY, "install.ps1");
const windows = process.platform === "win32";
// Each test starts PowerShell, which can take longer than the default 5 seconds on a busy runner (the tests then failed at 5.0 to 5.7 s).
if (windows) setDefaultTimeout(60_000);
const SIDE_FILES = ["claude-rc-launcher.xml", "claude-rc-launcher-run.ps1", "node.config.example.toml"];

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const q = (s: string) => s.replaceAll("'", "''"); // for a PowerShell single-quoted string

let root: string; // the whole test's folder
let server: ReturnType<typeof Bun.serve>;
let files: Map<string, Uint8Array>; // what the fake release serves, by path
let requests: string[];
let work: string; // where the script runs: no side files here
let zipOk: Uint8Array;
let regKey: string;
let regPath: string;

async function ps(command: string, env: Record<string, string> = {}, cwd?: string) {
  const p = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    stdout: "pipe", stderr: "pipe", cwd: cwd ?? work, env: { ...process.env, ...env, CLAUDE_RC_RELEASE_BASE: `http://127.0.0.1:${server.port}` },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
/** Runs the script text as a script block, the way `& ([scriptblock]::Create((irm <url>))) -Option` does. */
const asScriptBlock = (args: string, env: Record<string, string> = {}) =>
  ps(`& ([scriptblock]::Create([IO.File]::ReadAllText('${q(SCRIPT)}'))) ${args}`, env);

function publish(zip: Uint8Array, sumsOverride?: string) {
  files.set("/claude-rc-launcher-win-installer.zip", zip);
  files.set("/SHA256SUMS", new TextEncoder().encode(
    sumsOverride ?? [...files.entries()].filter(([p]) => p !== "/SHA256SUMS").map(([p, b]) => `${sha(b)}  ${p.slice(1)}\n`).join("")));
}

beforeAll(async () => {
  if (!windows) return;
  root = await mkdtemp(join(tmpdir(), "winboot-"));
  const zipPath = join(root, "installer.zip");
  const pack = await Bun.spawn(["powershell.exe", "-NoProfile", "-Command",
    `Compress-Archive -LiteralPath ${["install.ps1", ...SIDE_FILES].map((f) => `'${q(join(DEPLOY, f))}'`).join(",")} -DestinationPath '${q(zipPath)}' -Force`]).exited;
  if (pack !== 0) throw new Error("cannot build the test zip");
  zipOk = new Uint8Array(await readFile(zipPath));
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = files.get(path);
      return body ? new Response(body as unknown as BodyInit) : new Response("not found", { status: 404 });
    },
  });
});
afterAll(async () => {
  if (!windows) return;
  server.stop(true);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!windows) return;
  requests = [];
  files = new Map([
    ["/claude-rc-windows-x64.exe", new TextEncoder().encode("MZ fake client")],
    ["/claude-rc-launcher-win-x64.exe", new TextEncoder().encode("MZ fake node")],
  ]);
  publish(zipOk);
  work = await mkdtemp(join(root, "work-"));
  const name = `claude-rc-boottest-${Math.random().toString(36).slice(2)}`;
  regKey = `HKCU:\\Software\\${name}`;
  regPath = `HKCU\\Software\\${name}`;
  await Bun.spawn(["reg.exe", "add", regPath, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", "C:\\Windows", "/f"]).exited;
});
afterEach(async () => {
  if (!windows) return;
  await Bun.spawn(["reg.exe", "delete", regPath, "/f"]).exited;
  await Bun.spawn(["reg.exe", "delete", `${regPath}-client`, "/f"]).exited;
});

const nodeArgs = () => `-NoService -NoClient -Binary '${q(join(work, "node.exe"))}' -WinSW '${q(join(work, "winsw.exe"))}' -InstallDir '${q(join(work, "app"))}' -DataDir '${q(join(work, "data"))}'`;

describe.skipIf(!windows)("install.ps1 started without the release files (irm | iex)", () => {
  beforeEach(async () => {
    await writeFile(join(work, "node.exe"), "MZ node");
    await writeFile(join(work, "winsw.exe"), "MZ winsw");
  });

  test("as a script block: downloads the zip, checks it, and installs with the files from it", async () => {
    const r = await asScriptBlock(nodeArgs());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Downloading claude-rc-launcher-win-installer.zip");
    expect(requests).toEqual(["/claude-rc-launcher-win-installer.zip", "/SHA256SUMS"]);
    const xml = await readFile(join(work, "app", "service", "claude-rc-launcher-svc.xml"), "utf8");
    expect(xml).toContain("<id>claude-rc-launcher</id>"); // the XML came out of the zip
    expect(xml).toContain(join(work, "data", "config.toml"));
    expect(await readFile(join(work, "app", "service", "claude-rc-launcher-run.ps1"), "utf8")).toContain("update-pending.json");
    expect(await readFile(join(work, "data", "config.toml"), "utf8")).toContain('mode = "node"');
    expect(await readFile(join(work, "app", "service", "claude-rc-launcher.exe"), "utf8")).toBe("MZ node");
  });

  test("a lone install.ps1 run as a file does the same", async () => {
    const lone = join(work, "lone");
    await Bun.spawn(["cmd.exe", "/c", "mkdir", lone]).exited;
    await copyFile(SCRIPT, join(lone, "install.ps1"));
    const r = await ps(`& '${q(join(lone, "install.ps1"))}' ${nodeArgs()}`);
    expect(r.code).toBe(0);
    expect(requests).toContain("/claude-rc-launcher-win-installer.zip");
    expect(existsSync(join(work, "app", "service", "claude-rc-launcher-svc.xml"))).toBe(true);
  });

  test("a zip that does not match SHA256SUMS installs nothing", async () => {
    publish(zipOk, `${"0".repeat(64)}  claude-rc-launcher-win-installer.zip\n`);
    const r = await asScriptBlock(nodeArgs());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not match SHA256SUMS");
    expect(existsSync(join(work, "app"))).toBe(false);
    expect(existsSync(join(work, "data"))).toBe(false);
  });

  test("a zip with no line in SHA256SUMS is refused", async () => {
    publish(zipOk, "");
    const r = await asScriptBlock(nodeArgs());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not match SHA256SUMS");
  });

  test("a missing release file is a clear error", async () => {
    files.delete("/claude-rc-launcher-win-installer.zip");
    const r = await asScriptBlock(nodeArgs());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cannot download");
    expect(existsSync(join(work, "app"))).toBe(false);
  });

  test("a zip without the launcher script is refused, and does not loop", async () => {
    const bad = join(root, "bad.zip");
    await Bun.spawn(["powershell.exe", "-NoProfile", "-Command",
      `Compress-Archive -LiteralPath '${q(SCRIPT)}','${q(join(DEPLOY, "claude-rc-launcher.xml"))}' -DestinationPath '${q(bad)}' -Force`]).exited;
    publish(new Uint8Array(await readFile(bad)));
    const r = await asScriptBlock(nodeArgs());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not contain");
    expect(requests.filter((p) => p.endsWith(".zip"))).toHaveLength(1); // fetched once: no loop
  });

  test("-ClientOnly needs no zip: it fetches only the client and sets the PATH", async () => {
    const installDir = join(work, "claude rc");
    const clientDir = join(installDir, "bin");
    const r = await asScriptBlock(`-ClientOnly -InstallDir '${q(installDir)}' -ClientRegistryKey '${q(regKey)}-client' -PathRegistryKey '${q(regKey)}'`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(requests.sort()).toEqual(["/SHA256SUMS", "/claude-rc-windows-x64.exe"]);
    expect(await readFile(join(clientDir, "claude-rc.exe"), "utf8")).toBe("MZ fake client");
    const q2 = await Bun.spawn(["reg.exe", "query", regPath, "/v", "Path"], { stdout: "pipe" });
    expect(await new Response(q2.stdout).text()).toContain(`C:\\Windows;${clientDir}`);
  });

  test("a client that does not match SHA256SUMS is refused and the PATH is left alone", async () => {
    files.set("/SHA256SUMS", new TextEncoder().encode(`${"0".repeat(64)}  claude-rc-windows-x64.exe\n`));
    const installDir = join(work, "claude rc");
    const clientDir = join(installDir, "bin");
    const r = await asScriptBlock(`-ClientOnly -InstallDir '${q(installDir)}' -ClientRegistryKey '${q(regKey)}-client' -PathRegistryKey '${q(regKey)}'`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not match SHA256SUMS");
    expect(existsSync(installDir)).toBe(false);
    const q2 = await Bun.spawn(["reg.exe", "query", regPath, "/v", "Path"], { stdout: "pipe" });
    expect((await new Response(q2.stdout).text()).trim().endsWith("C:\\Windows")).toBe(true);
  });
});

describe.skipIf(!windows)("install.ps1 options as environment variables (| iex cannot pass parameters)", () => {
  // Plain `iex`, no parameters. Every case ends in an error before anything is changed.
  const viaIex = (env: Record<string, string>) => ps(`iex ([IO.File]::ReadAllText('${q(SCRIPT)}'))`, env);

  test("CLAUDE_RC_RELEASE is read, and checked like -Release", async () => {
    const r = await viaIex({ CLAUDE_RC_RELEASE: "latest" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("invalid release tag: latest");
    expect(requests).toEqual([]);
  });

  test("CLAUDE_RC_CLIENT_ONLY and CLAUDE_RC_NO_CLIENT are both read", async () => {
    const r = await viaIex({ CLAUDE_RC_CLIENT_ONLY: "1", CLAUDE_RC_NO_CLIENT: "1" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cannot be used together");
    expect(requests).toEqual([]);
  });

  test("0, false and no switch an option off", async () => {
    for (const off of ["0", "false", "no"]) {
      const r = await viaIex({ CLAUDE_RC_CLIENT_ONLY: off, CLAUDE_RC_NO_CLIENT: "1", CLAUDE_RC_RELEASE: "not-a-tag" });
      expect(r.err).not.toContain("cannot be used together"); // ClientOnly is off, so no conflict: the tag is the error
      expect(r.err).toContain("invalid release tag");
    }
  });

  test("a parameter wins over the environment", async () => {
    // -Release v1.2.3 is valid even though the variable is not: the script goes on to fetch from the test server.
    const r = await asScriptBlock(`-Release v1.2.3 -NoService -NoClient -Binary 'x' -InstallDir '${q(join(work, "b"))}' -DataDir '${q(join(work, "d"))}'`, { CLAUDE_RC_RELEASE: "not-a-tag" });
    expect(r.err).not.toContain("invalid release tag");
    expect(requests.length).toBeGreaterThan(0);
  });
});
