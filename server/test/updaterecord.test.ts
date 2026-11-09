import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UpdateRecord, type UpdateEntry } from "../src/updaterecord";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "updaterecord-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (o: Partial<UpdateEntry> = {}): UpdateEntry => ({
  host: "local",
  startedAt: "2026-11-09T10:00:00.000Z",
  startedBy: "alice",
  from: "0.8.2",
  status: "running",
  ...o,
});

describe("UpdateRecord", () => {
  test("a missing file loads as an empty list", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    expect(r.list()).toEqual([]);
  });

  test("set then load returns the entry, and the file has mode 0600", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    await r.set(entry());
    const again = await UpdateRecord.load({ stateDir: dir });
    expect(again.list()).toEqual([entry()]);
    if (process.platform !== "win32") expect((await stat(path.join(dir, "updates.json"))).mode & 0o777).toBe(0o600);
  });

  test("a second set for the same host replaces the entry", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    await r.set(entry());
    await r.set(entry({ status: "updated", to: "0.8.3" }));
    expect(r.list()).toEqual([entry({ status: "updated", to: "0.8.3" })]);
    expect((await UpdateRecord.load({ stateDir: dir })).list()).toHaveLength(1);
  });

  test("list returns a copy", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    await r.set(entry());
    r.list().pop();
    expect(r.list()).toHaveLength(1);
  });

  test("concurrent sets all end up in the file", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    await Promise.all([r.set(entry({ host: "a" })), r.set(entry({ host: "b" })), r.set(entry({ host: "c" }))]);
    const hosts = (await UpdateRecord.load({ stateDir: dir })).list().map((e) => e.host).sort();
    expect(hosts).toEqual(["a", "b", "c"]);
  });

  test("listeners get each change and stop after unsubscribe", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    const seen: string[] = [];
    const off = r.onChange((e) => seen.push(e.status));
    await r.set(entry());
    await r.set(entry({ status: "failed", error: "x" }));
    off();
    await r.set(entry({ status: "updated" }));
    expect(seen).toEqual(["running", "failed"]);
  });

  test("a throwing listener does not stop the others or fail set", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    const seen: string[] = [];
    r.onChange(() => {
      throw new Error("boom");
    });
    r.onChange((e) => seen.push(e.host));
    await r.set(entry());
    expect(seen).toEqual(["local"]);
  });

  test("reconcileHub marks a running local entry updated when the version changed", async () => {
    const r = await UpdateRecord.load({ stateDir: dir, now: () => new Date("2026-11-09T11:00:00.000Z") });
    await r.set(entry());
    await r.reconcileHub("0.8.3");
    expect(r.list()).toEqual([entry({ status: "updated", to: "0.8.3", finishedAt: "2026-11-09T11:00:00.000Z" })]);
    expect((await UpdateRecord.load({ stateDir: dir })).list()[0].status).toBe("updated");
  });

  test("reconcileHub marks it rolled back when the version is the same", async () => {
    const r = await UpdateRecord.load({ stateDir: dir, now: () => new Date("2026-11-09T11:00:00.000Z") });
    await r.set(entry({ from: "0.8.3" }));
    await r.reconcileHub("0.8.3");
    const e = r.list()[0];
    expect(e.status).toBe("rolled back");
    expect(e.finishedAt).toBe("2026-11-09T11:00:00.000Z");
  });

  test("reconcileHub leaves other hosts and finished entries alone, and writes nothing", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    await r.set(entry({ host: "other" }));
    await r.set(entry({ status: "updated", to: "0.8.3" }));
    const file = path.join(dir, "updates.json");
    const before = await stat(file);
    await Bun.sleep(20);
    const seen: string[] = [];
    r.onChange((e) => seen.push(e.host));
    await r.reconcileHub("0.9.0");
    expect(r.list().find((e) => e.host === "other")?.status).toBe("running");
    expect(r.list().find((e) => e.host === "local")?.status).toBe("updated");
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  test("a corrupt file loads as empty and the next set replaces it", async () => {
    await writeFile(path.join(dir, "updates.json"), "{not json");
    const r = await UpdateRecord.load({ stateDir: dir });
    expect(r.list()).toEqual([]);
    await r.set(entry());
    expect((await UpdateRecord.load({ stateDir: dir })).list()).toEqual([entry()]);
  });

  test("invalid entries are dropped when loading", async () => {
    const good = entry({ host: "good" });
    await writeFile(
      path.join(dir, "updates.json"),
      JSON.stringify({ updates: [good, { ...entry({ host: "bad" }), status: "weird" }, { host: "x" }, null, { ...entry({ host: "bad2" }), from: 3 }] }),
    );
    const r = await UpdateRecord.load({ stateDir: dir });
    expect(r.list()).toEqual([good]);
  });

  test("no .tmp file stays after set", async () => {
    const r = await UpdateRecord.load({ stateDir: dir });
    await r.set(entry());
    await r.set(entry({ host: "b" }));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, "updates.json"), "utf8")).updates).toHaveLength(2);
  });
});
