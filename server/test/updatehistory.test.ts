import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_ITEMS, UpdateHistory } from "../src/updatehistory";
import type { UpdateEntry } from "../src/updaterecord";

let dir: string;
beforeEach(async () => void (dir = await mkdtemp(path.join(tmpdir(), "updatehistory-"))));
afterEach(async () => void (await rm(dir, { recursive: true, force: true })));

const e = (o: Partial<UpdateEntry> = {}): UpdateEntry => ({ host: "win", startedAt: "2026-11-10T10:00:00.000Z", startedBy: "kir", from: "0.10.0", status: "updated", to: "0.10.1", ...o });
const line = (s: string) => ({ line: s, at: "2026-11-10T10:00:01.000Z" });

describe("UpdateHistory", () => {
  test("stores an item with its lines, newest first, and reloads it", async () => {
    const h = await UpdateHistory.load({ stateDir: dir });
    await h.add(e({ startedAt: "a" }), [line("one")]);
    await h.add(e({ startedAt: "b" }), [line("two")]);
    const again = await UpdateHistory.load({ stateDir: dir });
    expect(again.list().win!.map((i) => i.entry.startedAt)).toEqual(["b", "a"]);
    expect(again.list().win![0]!.lines[0]!.line).toBe("two");
  });
  test("ignores a running entry", async () => {
    const h = await UpdateHistory.load({ stateDir: dir });
    await h.add(e({ status: "running" }), []);
    expect(h.list()).toEqual({});
  });
  test("keeps the last 20 for each host", async () => {
    const h = await UpdateHistory.load({ stateDir: dir });
    for (let i = 0; i < MAX_ITEMS + 5; i++) await h.add(e({ startedAt: String(i).padStart(3, "0") }), []);
    await h.add(e({ host: "other" }), []);
    const l = h.list();
    expect(l.win!.length).toBe(MAX_ITEMS);
    expect(l.win![MAX_ITEMS - 1]!.entry.startedAt).toBe("005");
    expect(l.other!.length).toBe(1);
  });
  test("the same update replaces its item and keeps the lines when the new write has none", async () => {
    const h = await UpdateHistory.load({ stateDir: dir });
    await h.add(e({ status: "unknown", error: "x" }), [line("kept")]);
    await h.add(e(), []);
    const l = h.list().win!;
    expect(l.length).toBe(1);
    expect(l[0]!.entry.status).toBe("updated");
    expect(l[0]!.lines.map((x) => x.line)).toEqual(["kept"]);
  });
  test("cuts long lines and caps the line count", async () => {
    const h = await UpdateHistory.load({ stateDir: dir });
    await h.add(e(), Array.from({ length: 250 }, (_, i) => line(i === 249 ? "y".repeat(900) : "z")));
    const lines = h.list().win![0]!.lines;
    expect(lines.length).toBe(200);
    expect(lines[199]!.line.length).toBe(500);
  });
  test("a corrupt file loads as empty and a bad item is dropped", async () => {
    await writeFile(path.join(dir, "update-history.json"), "{nope");
    expect((await UpdateHistory.load({ stateDir: dir })).list()).toEqual({});
    await writeFile(path.join(dir, "update-history.json"), JSON.stringify({ items: [{ entry: { host: 1 }, lines: [] }, { entry: e(), lines: "x" }] }));
    const l = (await UpdateHistory.load({ stateDir: dir })).list();
    expect(l.win!.length).toBe(1);
    expect(l.win![0]!.lines).toEqual([]);
  });
  test("the file has mode 0600", async () => {
    const h = await UpdateHistory.load({ stateDir: dir });
    await h.add(e(), []);
    expect(await readFile(path.join(dir, "update-history.json"), "utf8")).toContain('"items"');
    if (process.platform !== "win32") expect(((await Bun.file(path.join(dir, "update-history.json")).stat()).mode & 0o777)).toBe(0o600);
  });
});
