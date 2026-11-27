import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_ITEMS, UpdateHistory } from "../../src/updates/UpdateHistory";
import type { UpdateEntry } from "../../src/updates/UpdateRecord";

let dir: string;
beforeEach(async () => void (dir = await mkdtemp(path.join(tmpdir(), "updatehistory-"))));
afterEach(async () => void (await rm(dir, { recursive: true, force: true })));

const helper = (item: Partial<UpdateEntry> = {}): UpdateEntry => ({
  host: "win",
  startedAt: "2026-11-10T10:00:00.000Z",
  startedBy: "kir",
  from: "0.10.0",
  status: "updated",
  to: "0.10.1",
  ...item,
});
const line = (item: string) => ({ line: item, at: "2026-11-10T10:00:01.000Z" });

describe("UpdateHistory", () => {
  test("stores an item with its lines, newest first, and reloads it", async () => {
    const updateHistory = await UpdateHistory.load({ stateDir: dir });
    await updateHistory.add(helper({ startedAt: "a" }), [line("one")]);
    await updateHistory.add(helper({ startedAt: "b" }), [line("two")]);
    const again = await UpdateHistory.load({ stateDir: dir });
    expect(again.list().win.map((item) => item.entry.startedAt)).toEqual(["b", "a"]);
    expect(again.list().win[0].lines[0].line).toBe("two");
  });
  test("ignores a running entry", async () => {
    const updateHistory = await UpdateHistory.load({ stateDir: dir });
    await updateHistory.add(helper({ status: "running" }), []);
    expect(updateHistory.list()).toEqual({});
  });
  test("keeps the last 20 for each host", async () => {
    const updateHistory = await UpdateHistory.load({ stateDir: dir });
    for (let index = 0; index < MAX_ITEMS + 5; index++)
      await updateHistory.add(helper({ startedAt: String(index).padStart(3, "0") }), []);
    await updateHistory.add(helper({ host: "other" }), []);
    const item = updateHistory.list();
    expect(item.win.length).toBe(MAX_ITEMS);
    expect(item.win[MAX_ITEMS - 1].entry.startedAt).toBe("005");
    expect(item.other.length).toBe(1);
  });
  test("the same update replaces its item and keeps the lines when the new write has none", async () => {
    const updateHistory = await UpdateHistory.load({ stateDir: dir });
    await updateHistory.add(helper({ status: "unknown", error: "x" }), [line("kept")]);
    await updateHistory.add(helper(), []);
    const historyItems = updateHistory.list().win;
    expect(historyItems.length).toBe(1);
    expect(historyItems[0].entry.status).toBe("updated");
    expect(historyItems[0].lines.map((logLine) => logLine.line)).toEqual(["kept"]);
  });
  test("cuts long lines and caps the line count", async () => {
    const updateHistory = await UpdateHistory.load({ stateDir: dir });
    await updateHistory.add(
      helper(),
      Array.from({ length: 250 }, (_unused, item) => line(item === 249 ? "y".repeat(900) : "z")),
    );
    const lines = updateHistory.list().win[0].lines;
    expect(lines.length).toBe(200);
    expect(lines[199].line.length).toBe(500);
  });
  test("a corrupt file loads as empty and a bad item is dropped", async () => {
    await writeFile(path.join(dir, "update-history.json"), "{nope");
    expect((await UpdateHistory.load({ stateDir: dir })).list()).toEqual({});
    await writeFile(
      path.join(dir, "update-history.json"),
      JSON.stringify({
        items: [
          { entry: { host: 1 }, lines: [] },
          { entry: helper(), lines: "x" },
        ],
      }),
    );
    const item = (await UpdateHistory.load({ stateDir: dir })).list();
    expect(item.win.length).toBe(1);
    expect(item.win[0].lines).toEqual([]);
  });
  test("the file has mode 0600", async () => {
    const updateHistory = await UpdateHistory.load({ stateDir: dir });
    await updateHistory.add(helper(), []);
    expect(await readFile(path.join(dir, "update-history.json"), "utf8")).toContain('"items"');
    if (process.platform !== "win32")
      expect((await Bun.file(path.join(dir, "update-history.json")).stat()).mode & 0o777).toBe(0o600);
  });
});
