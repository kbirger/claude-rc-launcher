import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionChains } from "../../src/sessions/SessionChains";

const item = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const entry = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const value = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("SessionChains", () => {
  test("sessions with one bridge id are one chain, oldest first", async () => {
    const sessionChains = new SessionChains();
    await sessionChains.observe([["cse_1", item]]);
    await sessionChains.observe([["cse_1", entry]]);
    await sessionChains.observe([
      ["cse_1", entry],
      ["cse_2", value],
    ]);
    expect(await sessionChains.chainOf(entry)).toEqual([item, entry]);
    expect(await sessionChains.chainOf(item)).toEqual([item, entry]);
    expect(await sessionChains.chainOf(value)).toEqual([value]);
  });

  test("a link and a bridge id join into one chain, also through other ids", async () => {
    const sessionChains = new SessionChains();
    await sessionChains.link(item, entry);
    await sessionChains.observe([
      ["cse_1", entry],
      ["cse_1", value],
    ]);
    expect((await sessionChains.chainOf(item)).sort()).toEqual([item, entry, value]);
    expect((await sessionChains.chainOf(value)).sort()).toEqual([item, entry, value]);
    await sessionChains.link(item, item);
    await sessionChains.link("bad", item);
    expect((await sessionChains.chainOf("dddddddd-dddd-dddd-dddd-dddddddddddd")).length).toBe(1);
  });

  test("a bad session id or an empty bridge id is ignored", async () => {
    const sessionChains = new SessionChains();
    await sessionChains.observe([
      ["", item],
      ["cse_1", "../x"],
    ]);
    expect(await sessionChains.chainOf(item)).toEqual([item]);
  });

  test("the store is saved and loaded again, and a bad file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chains-"));

    try {
      const file = join(dir, "sub", "chains.json");
      await new SessionChains(file).observe([
        ["cse_1", item],
        ["cse_1", entry],
      ]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ cse_1: [item, entry] });
      expect(await new SessionChains(file).chainOf(item)).toEqual([item, entry]);
      const bad = join(dir, "bad.json");
      await writeFile(bad, "{nope");
      expect(await new SessionChains(bad).chainOf(item)).toEqual([item]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it keeps at most 1000 bridges", async () => {
    const sessionChains = new SessionChains();
    for (let index = 0; index < 1002; index++)
      await sessionChains.observe([[`cse_${index}`, `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`]]);
    expect(await sessionChains.chainOf("00000000-0000-0000-0000-000000000000")).toEqual([
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect((await sessionChains.chainOf("00000000-0000-0000-0000-000000001001")).length).toBe(1);
  });
});
