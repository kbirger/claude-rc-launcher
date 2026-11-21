import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UpdateRecord } from "../src/updaterecord";
import type { UpdateEntry } from "../src/updaterecord";
import { rejection, defined } from "./support";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "updaterecord-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (item: Partial<UpdateEntry> = {}): UpdateEntry => ({
  host: "local",
  startedAt: "2026-11-09T10:00:00.000Z",
  startedBy: "alice",
  from: "0.8.2",
  status: "running",
  ...item,
});

describe("UpdateRecord", () => {
  test("step and stepDetail round-trip while running, reach listeners, and a final status drops them", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    const seen: UpdateEntry[] = [];
    updateRecord.onChange((updateEntry) => seen.push(updateEntry));
    await updateRecord.set(entry({ host: "nas", step: "installing", stepDetail: "claude-rc 1.1.0" }));
    expect(seen[0]).toMatchObject({ step: "installing", stepDetail: "claude-rc 1.1.0" });
    expect((await UpdateRecord.load({ stateDir: dir })).list()).toEqual([
      entry({ host: "nas", step: "installing", stepDetail: "claude-rc 1.1.0" }),
    ]);
    await updateRecord.set(entry({ host: "nas", status: "updated", step: "installing", stepDetail: "x" }));
    expect(seen[1].step).toBeUndefined();
    expect(updateRecord.list()[0]).toEqual(entry({ host: "nas", status: "updated" }));
    expect(await readFile(path.join(dir, "updates.json"), "utf8")).not.toContain("step");
    await updateRecord.setIf(entry({ host: "b", status: "failed", step: "failed" }), () => true);
    expect(defined(updateRecord.list().find((updateEntry) => updateEntry.host === "b")).step).toBeUndefined();
  });

  test("valid and clean accept step fields on a running entry and drop them on a final one when loading", async () => {
    await writeFile(
      path.join(dir, "updates.json"),
      JSON.stringify({
        updates: [
          entry({ host: "a", step: "verifying", stepDetail: "d" }),
          { ...entry({ host: "b", status: "failed" }), step: "failed" },
          { ...entry({ host: "c" }), step: 5 },
        ],
      }),
    );
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    expect(updateRecord.list()).toEqual([
      entry({ host: "a", step: "verifying", stepDetail: "d" }),
      entry({ host: "b", status: "failed" }),
    ]);
  });

  test("markStaleRunning and reconcileHub drop the step", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry({ host: "nas", step: "restarting" }));
    await updateRecord.set(entry({ host: "local", step: "restarting" }));
    await updateRecord.markStaleRunning();
    await updateRecord.reconcileHub("0.9.0");
    expect(
      updateRecord.list().every((updateEntry) => updateEntry.step === undefined && updateEntry.status !== "running"),
    ).toBe(true);
  });

  test("a missing file loads as an empty list", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    expect(updateRecord.list()).toEqual([]);
  });

  test("set then load returns the entry, and the file has mode 0600", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry());
    const again = await UpdateRecord.load({ stateDir: dir });
    expect(again.list()).toEqual([entry()]);
    if (process.platform !== "win32") expect((await stat(path.join(dir, "updates.json"))).mode & 0o777).toBe(0o600);
  });

  test("a second set for the same host replaces the entry", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry());
    await updateRecord.set(entry({ status: "updated", to: "0.8.3" }));
    expect(updateRecord.list()).toEqual([entry({ status: "updated", to: "0.8.3" })]);
    expect((await UpdateRecord.load({ stateDir: dir })).list()).toHaveLength(1);
  });

  test("list returns a copy", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry());
    updateRecord.list().pop();
    expect(updateRecord.list()).toHaveLength(1);
  });

  test("concurrent sets all end up in the file", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await Promise.all([
      updateRecord.set(entry({ host: "a" })),
      updateRecord.set(entry({ host: "b" })),
      updateRecord.set(entry({ host: "c" })),
    ]);
    const hosts = (await UpdateRecord.load({ stateDir: dir }))
      .list()
      .map((updateEntry) => updateEntry.host)
      .sort();
    expect(hosts).toEqual(["a", "b", "c"]);
  });

  test("listeners get each change and stop after unsubscribe", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    const seen: string[] = [];
    const off = updateRecord.onChange((updateEntry) => seen.push(updateEntry.status));
    await updateRecord.set(entry());
    await updateRecord.set(entry({ status: "failed", error: "x" }));
    off();
    await updateRecord.set(entry({ status: "updated" }));
    expect(seen).toEqual(["running", "failed"]);
  });

  test("a throwing listener does not stop the others or fail set", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    const seen: string[] = [];
    updateRecord.onChange(() => {
      throw new Error("boom");
    });
    updateRecord.onChange((updateEntry) => seen.push(updateEntry.host));
    await updateRecord.set(entry());
    expect(seen).toEqual(["local"]);
  });

  test("reconcileHub marks a running local entry updated when the version changed", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir, now: () => new Date("2026-11-09T11:00:00.000Z") });
    await updateRecord.set(entry());
    await updateRecord.reconcileHub("0.8.3");
    expect(updateRecord.list()).toEqual([
      entry({ status: "updated", to: "0.8.3", finishedAt: "2026-11-09T11:00:00.000Z" }),
    ]);
    expect((await UpdateRecord.load({ stateDir: dir })).list()[0].status).toBe("updated");
  });

  test("reconcileHub marks it rolled back when the version is the same", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir, now: () => new Date("2026-11-09T11:00:00.000Z") });
    await updateRecord.set(entry({ from: "0.8.3" }));
    await updateRecord.reconcileHub("0.8.3");
    const updateEntry = updateRecord.list()[0];
    expect(updateEntry.status).toBe("rolled back");
    expect(updateEntry.finishedAt).toBe("2026-11-09T11:00:00.000Z");
  });

  test("reconcileHub leaves other hosts and finished entries alone, and writes nothing", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry({ host: "other" }));
    await updateRecord.set(entry({ status: "updated", to: "0.8.3" }));
    const file = path.join(dir, "updates.json");
    const before = await stat(file);
    await Bun.sleep(20);
    const seen: string[] = [];
    updateRecord.onChange((updateEntry) => seen.push(updateEntry.host));
    await updateRecord.reconcileHub("0.9.0");
    expect(updateRecord.list().find((updateEntry) => updateEntry.host === "other")?.status).toBe("running");
    expect(updateRecord.list().find((updateEntry) => updateEntry.host === "local")?.status).toBe("updated");
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(seen).toEqual([]);
  });

  test("a corrupt file loads as empty and the next set replaces it", async () => {
    await writeFile(path.join(dir, "updates.json"), "{not json");
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    expect(updateRecord.list()).toEqual([]);
    await updateRecord.set(entry());
    expect((await UpdateRecord.load({ stateDir: dir })).list()).toEqual([entry()]);
  });

  test("an unreadable file makes load reject instead of loading empty", async () => {
    await mkdir(path.join(dir, "updates.json"));
    expect((await rejection(UpdateRecord.load({ stateDir: dir }))).message).toMatch(/cannot read .*updates\.json/);
  });

  test("invalid entries are dropped when loading", async () => {
    const good = entry({ host: "good" });
    await writeFile(
      path.join(dir, "updates.json"),
      JSON.stringify({
        updates: [
          good,
          { ...entry({ host: "bad" }), status: "weird" },
          { host: "x" },
          null,
          { ...entry({ host: "bad2" }), from: 3 },
        ],
      }),
    );
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    expect(updateRecord.list()).toEqual([good]);
  });

  test("no .tmp file stays after set", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry());
    await updateRecord.set(entry({ host: "b" }));
    expect((await readdir(dir)).filter((item) => item.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, "updates.json"), "utf8")).updates).toHaveLength(2);
  });
});

describe("UpdateRecord setIf and markStaleRunning", () => {
  test("setIf writes only when the check allows it", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    expect(await updateRecord.setIf(entry({ host: "a" }), (current) => current === undefined)).toBe(true);
    expect(await updateRecord.setIf(entry({ host: "a", from: "9" }), (current) => current === undefined)).toBe(false);
    expect(updateRecord.list()[0].from).toBe("0.8.2");
  });
  test("markStaleRunning settles running nodes, not local, and writes only on change", async () => {
    const updateRecord = await UpdateRecord.load({ stateDir: dir, now: () => new Date("2026-11-09T11:00:00.000Z") });
    await updateRecord.set(entry({ host: "local" }));
    await updateRecord.set(entry({ host: "nas" }));
    await updateRecord.set(entry({ host: "pi", status: "updated" }));
    await updateRecord.markStaleRunning();
    const by = (item: string) => defined(updateRecord.list().find((updateEntry) => updateEntry.host === item));
    expect(by("local").status).toBe("running");
    expect(by("pi").status).toBe("updated");
    expect(by("nas")).toMatchObject({
      status: "unknown",
      error: "the hub restarted while the update ran",
      finishedAt: "2026-11-09T11:00:00.000Z",
    });
    let count = 0;
    updateRecord.onChange(() => count++);
    await updateRecord.markStaleRunning();
    expect(count).toBe(0);
  });
});

/** Repeats `check` until it passes or two seconds are over: the writes are asynchronous and a fixed wait fails on a slow runner. */
async function eventually(check: () => void, ms = 2000): Promise<void> {
  const end = Date.now() + ms;

  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
      await Bun.sleep(10);
    }
  }
}

describe("stepWriter", () => {
  test("writes step and a detail cut to 200 characters while running, and nothing otherwise", async () => {
    const { stepWriter } = await import("../src/hubmain");
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    const write = stepWriter(updateRecord);
    write("nas", { step: "installing" });
    await Bun.sleep(30);
    expect(updateRecord.list()).toEqual([]);
    await updateRecord.set(entry({ host: "nas" }));
    write("nas", { step: "installing-client", client: "x".repeat(300) });
    write("nas", { step: "installing", detail: "d" });
    await eventually(() => {
      expect(updateRecord.list()[0]).toEqual(entry({ host: "nas", step: "installing", stepDetail: "d" }));
    });
    write("nas", { step: "restarting" });
    await eventually(() => {
      expect(updateRecord.list()[0].stepDetail).toBeUndefined();
    });
    await updateRecord.set(entry({ host: "nas", status: "failed" }));
    write("nas", { step: "failed" });
    await eventually(() => {
      expect(updateRecord.list()[0]).toEqual(entry({ host: "nas", status: "failed" }));
    });
  });
  test("a new run with another startedAt is not overwritten by a step of the old run", async () => {
    const { stepWriter } = await import("../src/hubmain");
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry({ host: "nas", startedAt: "2026-11-10T10:00:00.000Z", startedBy: "ann" }));
    const realSetIf = updateRecord.setIf.bind(updateRecord);

    // A new run begins after the writer has read the old entry but before its write takes the lock.
    updateRecord.setIf = async (next, pred) => {
      await updateRecord.set(entry({ host: "nas", startedAt: "2026-11-10T11:00:00.000Z", startedBy: "bob" }));
      return realSetIf(next, pred);
    };

    stepWriter(updateRecord)("nas", { step: "installing" });
    await eventually(() => {
      expect(updateRecord.list()[0]).toEqual(
        entry({ host: "nas", startedAt: "2026-11-10T11:00:00.000Z", startedBy: "bob" }),
      );
    });
  });
  test("a step that repeats the current step and detail does not write", async () => {
    const { stepWriter } = await import("../src/hubmain");
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry({ host: "nas" }));
    let writes = 0;
    const realSetIf = updateRecord.setIf.bind(updateRecord);
    updateRecord.setIf = (next, pred) => (writes++, realSetIf(next, pred));
    const write = stepWriter(updateRecord);
    write("nas", { step: "installing", detail: "d" });
    await Bun.sleep(30);
    write("nas", { step: "installing", detail: "d" });
    write("nas", { step: "installing", detail: "d" });
    await Bun.sleep(30);
    expect(writes).toBe(1);
    write("nas", { step: "installing", detail: "e" });
    write("nas", { step: "restarting" });
    await eventually(() => {
      expect(writes).toBe(3);
    });
  });
  test("a client detail is cut to 200 characters", async () => {
    const { stepWriter } = await import("../src/hubmain");
    const updateRecord = await UpdateRecord.load({ stateDir: dir });
    await updateRecord.set(entry({ host: "nas" }));
    stepWriter(updateRecord)("nas", { step: "installing-client", client: "x".repeat(300) });
    await eventually(() => {
      expect(updateRecord.list()[0].stepDetail).toHaveLength(200);
    });
  });
});
