import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NameMemory } from "../src/namememory";
import { SessionCatalog } from "../src/sessioncatalog";
import type { TranscriptFs } from "../src/transcriptfs";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const DAY = 24 * 60 * 60 * 1000;

describe("NameMemory", () => {
  test("a better source is never replaced by a worse one", async () => {
    const m = new NameMemory();
    await m.resolve({ id: A, chain: [A], candidate: { name: "From prompt", source: "prompt" } });
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "AI title", source: "ai" } }))?.name).toBe("AI title");
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "Later prompt", source: "prompt" } }))?.name).toBe("AI title");
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "Default-1", source: "default" } }))?.name).toBe("AI title");
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "Renamed", source: "custom" } }))?.name).toBe("Renamed");
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "Renamed again", source: "custom" } }))?.name).toBe("Renamed again");
  });

  test("the first prompt stays when a later prompt (after /compact) is read", async () => {
    const m = new NameMemory();
    await m.resolve({ id: A, chain: [A], candidate: { name: "Original prompt", source: "prompt" } });
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "After compact", source: "prompt" } }))?.name).toBe("Original prompt");
  });

  test("a default name is shown when nothing else is known, but it is not remembered", async () => {
    const m = new NameMemory();
    expect((await m.resolve({ id: A, chain: [A], candidate: { name: "proj-91", source: "default" } }))?.name).toBe("proj-91");
    expect(await m.resolve({ id: A, chain: [A] })).toBeUndefined();
  });

  test("a chain finds the name of an older member", async () => {
    const m = new NameMemory();
    await m.resolve({ id: A, chain: [A], candidate: { name: "Shadcdn MCP", source: "ai" } });
    expect((await m.resolve({ id: B, chain: [A, B], candidate: { name: "proj-91", source: "default" } }))?.name).toBe("Shadcdn MCP");
    // now B has it too, so it survives when A is no longer in the chain
    expect((await m.resolve({ id: B, chain: [B] }))?.name).toBe("Shadcdn MCP");
  });

  test("it is saved and loaded again, and a bad or big file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "names-"));
    try {
      const file = join(dir, "sub", "names.json");
      await new NameMemory(file).resolve({ id: A, chain: [A], candidate: { name: "Kept", source: "ai" }, file: "/t/a.jsonl" });
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw[A]).toMatchObject({ name: "Kept", source: "ai", file: "/t/a.jsonl" });
      expect((await new NameMemory(file).resolve({ id: A, chain: [A] }))?.name).toBe("Kept");
      const bad = join(dir, "bad.json");
      await writeFile(bad, "{nope");
      expect(await new NameMemory(bad).resolve({ id: A, chain: [A] })).toBeUndefined();
      const big = join(dir, "big.json");
      await writeFile(big, JSON.stringify({ [A]: { name: "x".repeat(1024 * 1024), source: "ai", seen: 1 } }));
      expect(await new NameMemory(big).resolve({ id: A, chain: [A] })).toBeUndefined();
      const odd = join(dir, "odd.json");
      await writeFile(odd, JSON.stringify({ [A]: { name: "ok", source: "bogus", seen: 1 }, "../x": { name: "ok", source: "ai", seen: 1 }, [B]: { name: "y".repeat(500), source: "ai", seen: 1 } }));
      const m = new NameMemory(odd);
      expect(await m.resolve({ id: A, chain: [A] })).toBeUndefined();
      expect((await m.resolve({ id: B, chain: [B] }))?.name.length).toBeLessThanOrEqual(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it keeps at most 1000 names and drops the oldest seen first", async () => {
    let t = 1_000_000;
    const m = new NameMemory(undefined, () => t++);
    for (let i = 0; i < 1002; i++) await m.resolve({ id: id(i), chain: [id(i)], candidate: { name: `n${i}`, source: "ai" } });
    expect(await m.resolve({ id: id(0), chain: [id(0)] })).toBeUndefined();
    expect(await m.resolve({ id: id(1), chain: [id(1)] })).toBeUndefined();
    expect((await m.resolve({ id: id(1001), chain: [id(1001)] }))?.name).toBe("n1001");
  });

  test("a listed session is seen again, so it outlives an idle one", async () => {
    let t = 1_000_000;
    const m = new NameMemory(undefined, () => t);
    await m.resolve({ id: id(0), chain: [id(0)], candidate: { name: "used", source: "ai" } });
    for (let i = 1; i < 1000; i++) await m.resolve({ id: id(i), chain: [id(i)], candidate: { name: `n${i}`, source: "ai" } });
    t += 10 * DAY;
    await m.resolve({ id: id(0), chain: [id(0)] });
    t += 1;
    await m.resolve({ id: id(2000), chain: [id(2000)], candidate: { name: "new", source: "ai" } });
    expect((await m.resolve({ id: id(0), chain: [id(0)] }))?.name).toBe("used");
    expect(await m.resolve({ id: id(1), chain: [id(1)] })).toBeUndefined();
  });

  describe("the sweep of names whose transcript is gone", () => {
    const fsOf = (present: Set<string>, errors: Record<string, string> = {}): TranscriptFs => ({
      async readdir() { return []; },
      async stat(p) {
        if (errors[p]) throw Object.assign(new Error(errors[p]), { code: errors[p] });
        if (!present.has(p)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return { mtimeMs: 1 };
      },
      async *lines() {},
    });

    test("it deletes the name of a missing transcript at the first call, then at most once a day", async () => {
      let t = 10 * DAY;
      const dir = await mkdtemp(join(tmpdir(), "names-"));
      try {
        const file = join(dir, "n.json");
        const seed = new NameMemory(file, () => t);
        await seed.resolve({ id: A, chain: [A], candidate: { name: "Gone", source: "ai" }, file: "/t/a.jsonl" });
        await seed.resolve({ id: B, chain: [B], candidate: { name: "Stays", source: "ai" }, file: "/t/b.jsonl" });
        const present = new Set(["/t/b.jsonl"]);
        const m = new NameMemory(file, () => t);
        m.useFs(fsOf(present));
        expect(await m.resolve({ id: A, chain: [A] })).toBeUndefined();
        expect((await m.resolve({ id: B, chain: [B] }))?.name).toBe("Stays");
        expect(JSON.parse(await readFile(file, "utf8"))[A]).toBeUndefined();
        // within a day a new gap is not swept; after a day it is
        present.delete("/t/b.jsonl");
        t += DAY / 2;
        expect((await m.resolve({ id: B, chain: [B] }))?.name).toBe("Stays");
        t += DAY;
        expect(await m.resolve({ id: B, chain: [B] })).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("an error other than a missing file keeps the name", async () => {
      const m = new NameMemory(undefined, () => 10 * DAY);
      await m.resolve({ id: A, chain: [A], candidate: { name: "Kept", source: "ai" }, file: "/t/a.jsonl" });
      m.useFs(fsOf(new Set(), { "/t/a.jsonl": "EACCES" }));
      (m as any).lastSweep = 0;
      expect((await m.resolve({ id: A, chain: [A] }))?.name).toBe("Kept");
    });
  });
});

describe("the catalog uses the name memory", () => {
  const FILE = "/h/.claude/projects/-work-proj/" + A + ".jsonl";
  const rec = (o: object) => JSON.stringify({ cwd: "/work/proj", timestamp: "2026-01-01T00:00:00.000Z", ...o });
  const user = (text: string, extra: object = {}) => rec({ type: "user", message: { content: text }, ...extra });
  function fsOf(lines: () => string[]): TranscriptFs {
    return {
      async readdir(dir) { return dir === "/h/.claude/projects" ? ["-work-proj"] : [A + ".jsonl"]; },
      async stat(p) { if (p !== FILE) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return { mtimeMs: Date.now(), size: lines().join("\n").length }; },
      async *lines() { for (const l of lines()) yield l; },
      async tail() { return lines(); },
    };
  }

  test.skipIf(process.platform === "win32")("a name read before /compact survives it", async () => {
    let lines = [user("Fix the login bug")];
    const cat = new SessionCatalog({ fs: fsOf(() => lines) });
    const inst = cat.instance({ path: "/work/proj", home: "/h" });
    expect((await inst.list())[0].name).toBe("Fix the login bug");
    lines = [user("This session is being continued from a previous conversation.", { isCompactSummary: true }), user("now add tests")];
    expect((await inst.list())[0].name).toBe("Fix the login bug");
  });

  test.skipIf(process.platform === "win32")("a title found later replaces the remembered prompt, and a default live name does not", async () => {
    let lines = [user("Fix the login bug")];
    const cat = new SessionCatalog({ fs: fsOf(() => lines), live: async () => new Map([[A, { remoteControl: true, name: "proj-91", nameIsDefault: true }]]) });
    const inst = cat.instance({ path: "/work/proj", home: "/h" });
    expect((await inst.list())[0].name).toBe("Fix the login bug");
    lines = [user("later"), rec({ type: "ai-title", aiTitle: "Login fix" })];
    expect((await inst.list())[0].name).toBe("Login fix");
    lines = [user("even later")];
    expect((await inst.list())[0].name).toBe("Login fix");
  });
});
