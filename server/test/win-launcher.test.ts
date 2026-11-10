import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// deploy/windows/claude-rc-launcher-run.ps1 runs only on Windows. The agent is replaced by two stub programs:
// "OLD" exits with 0 and "NEW" exits with 7, so the exit code tells which one the launcher started.
const SCRIPT = resolve(import.meta.dir, "../../deploy/windows/claude-rc-launcher-run.ps1");
const windows = process.platform === "win32";

let stubs: string;
let work: string;
let exe: string;
let data: string;
const pending = () => join(data, "update-pending.json");
const updateLog = () => join(data, "logs", "update.log");

async function buildStub(name: string, code: number): Promise<string> {
  const src = join(stubs, `${name}.ts`);
  const out = join(stubs, `${name}.exe`);
  await writeFile(src, `console.log("STUB ${name} " + JSON.stringify(process.argv.slice(2)));\nprocess.exit(${code});\n`);
  const p = Bun.spawn([process.execPath, "build", "--compile", src, "--outfile", out], { stdout: "pipe", stderr: "pipe" });
  const code2 = await p.exited;
  if (code2 !== 0) throw new Error(`cannot build the ${name} stub: ${await new Response(p.stderr).text()}`);
  return out;
}

beforeAll(async () => {
  if (!windows) return;
  stubs = await mkdtemp(join(tmpdir(), "launcher-stubs-"));
  await Promise.all([buildStub("OLD", 0), buildStub("NEW", 7)]);
}, 60_000);
afterAll(async () => { if (windows) await rm(stubs, { recursive: true, force: true }); });

beforeEach(async () => {
  if (!windows) return;
  work = await mkdtemp(join(tmpdir(), "launcher-work-"));
  exe = join(work, "claude-rc-launcher.exe");
  data = join(work, "data with space");
  await copyFile(join(stubs, "NEW.exe"), exe); // the installed binary is the new one
});
// A process that just ended can still hold the folder for a moment on Windows (EBUSY), so removing it is retried.
afterEach(async () => { if (windows) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

// Each launch starts powershell.exe, which takes about 2 seconds on a CI runner. Bun's default of 5 seconds is too short for a test with 2 or 3 launches.
const SLOW = 60_000;
/** Fails with what the script printed, so that a wrong exit code can be diagnosed from the log. */
function expectCode(r: { code: number; out: string; err: string }, want: number) {
  if (r.code !== want) throw new Error(`exit code ${r.code}, want ${want}\nstdout: ${r.out}\nstderr: ${r.err}`);
}

async function launch(extra: string[] = []) {
  const p = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Exe", exe, "-Config", join(work, "my config.toml"), "-DataDir", data, ...extra],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
const writePending = (obj: object) => writeFile(pending(), JSON.stringify(obj)).catch(async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(data, { recursive: true });
  await writeFile(pending(), JSON.stringify(obj));
});

describe.skipIf(!windows)("claude-rc-launcher-run.ps1", () => {
  test("starts the agent with --config and returns its exit code", async () => {
    const r = await launch();
    expectCode(r, 7);
    expect(r.out).toContain("STUB NEW");
    expect(r.out).toContain(`--config`);
    expect(r.out).toContain("my config.toml"); // a path with a space arrives as one argument
    expect(existsSync(pending())).toBe(false);
  }, SLOW);

  test("an unconfirmed update counts every start", async () => {
    await writePending({ from: "0.5.0", to: "0.5.1", starts: 0 });
    for (const n of [1, 2, 3]) {
      const r = await launch();
      expectCode(r, 7); // the new agent is started each time
      expect(JSON.parse(await readFile(pending(), "utf8")).starts).toBe(n);
    }
    expect(await readFile(updateLog(), "utf8")).toContain("start 3 of 3");
  }, SLOW);

  test("after too many unconfirmed starts, the old binary is put back and started", async () => {
    await writePending({ from: "0.5.0", to: "0.5.1", starts: 3 });
    await copyFile(join(stubs, "OLD.exe"), `${exe}.prev`);
    const r = await launch();
    expectCode(r, 0); // OLD ran
    expect(r.out).toContain("STUB OLD");
    expect(existsSync(`${exe}.prev`)).toBe(false);
    expect(existsSync(pending())).toBe(false);
    expect(await readFile(updateLog(), "utf8")).toContain("did not stay up: restored");
    // and the next start is a normal start of the old binary
    expectCode(await launch(), 0);
  }, SLOW);

  test("with no .prev to restore, the marker is removed and the installed binary still starts", async () => {
    await writePending({ from: "0.5.0", to: "0.5.1", starts: 3 });
    const r = await launch();
    expectCode(r, 7);
    expect(existsSync(pending())).toBe(false);
    expect(await readFile(updateLog(), "utf8")).toContain("is missing");
  }, SLOW);

  test("a marker that cannot be read is removed and the agent still starts", async () => {
    await writePending({});
    await writeFile(pending(), "{ nope");
    const r = await launch();
    expectCode(r, 7);
    expect(existsSync(pending())).toBe(false);
    expect(await readFile(updateLog(), "utf8")).toContain("cannot use");
  }, SLOW);

  test("a different limit can be given", async () => {
    await writePending({ from: "0.5.0", to: "0.5.1", starts: 1 });
    await copyFile(join(stubs, "OLD.exe"), `${exe}.prev`);
    expectCode(await launch(["-MaxStarts", "1"]), 0); // 2 > 1: rolled back
  }, SLOW);
});
