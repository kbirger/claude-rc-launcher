import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionChains } from "../src/sessionchains";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("SessionChains", () => {
  test("sessions with one bridge id are one chain, oldest first", async () => {
    const c = new SessionChains();
    await c.observe([["cse_1", A]]);
    await c.observe([["cse_1", B]]);
    await c.observe([["cse_1", B], ["cse_2", C]]);
    expect(await c.chainOf(B)).toEqual([A, B]);
    expect(await c.chainOf(A)).toEqual([A, B]);
    expect(await c.chainOf(C)).toEqual([C]);
  });

  test("a link and a bridge id join into one chain, also through other ids", async () => {
    const c = new SessionChains();
    await c.link(A, B);
    await c.observe([["cse_1", B], ["cse_1", C]]);
    expect((await c.chainOf(A)).sort()).toEqual([A, B, C]);
    expect((await c.chainOf(C)).sort()).toEqual([A, B, C]);
    await c.link(A, A);
    await c.link("bad", A);
    expect((await c.chainOf("dddddddd-dddd-dddd-dddd-dddddddddddd")).length).toBe(1);
  });

  test("a bad session id or an empty bridge id is ignored", async () => {
    const c = new SessionChains();
    await c.observe([["", A], ["cse_1", "../x"]]);
    expect(await c.chainOf(A)).toEqual([A]);
  });

  test("the store is saved and loaded again, and a bad file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chains-"));
    try {
      const file = join(dir, "sub", "chains.json");
      await new SessionChains(file).observe([["cse_1", A], ["cse_1", B]]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ cse_1: [A, B] });
      expect(await new SessionChains(file).chainOf(A)).toEqual([A, B]);
      const bad = join(dir, "bad.json");
      await writeFile(bad, "{nope");
      expect(await new SessionChains(bad).chainOf(A)).toEqual([A]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it keeps at most 1000 bridges", async () => {
    const c = new SessionChains();
    for (let i = 0; i < 1002; i++) await c.observe([[`cse_${i}`, `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`]]);
    expect(await c.chainOf("00000000-0000-0000-0000-000000000000")).toEqual(["00000000-0000-0000-0000-000000000000"]);
    expect((await c.chainOf("00000000-0000-0000-0000-000000001001")).length).toBe(1);
  });
});
