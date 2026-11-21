import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NameMemory } from "../src/namememory";
import { SessionCatalog } from "../src/sessioncatalog";
import type { TranscriptFs } from "../src/transcriptfs";

const item = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const entry = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
const DAY = 24 * 60 * 60 * 1000;

describe("NameMemory", () => {
  test("a better source is never replaced by a worse one", async () => {
    const nameMemory = new NameMemory();
    await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "From prompt", source: "prompt" } });
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "AI title", source: "ai" } }))?.name,
    ).toBe("AI title");
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "Later prompt", source: "prompt" } }))
        ?.name,
    ).toBe("AI title");
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "Default-1", source: "default" } }))
        ?.name,
    ).toBe("AI title");
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "Renamed", source: "custom" } }))?.name,
    ).toBe("Renamed");
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "Renamed again", source: "custom" } }))
        ?.name,
    ).toBe("Renamed again");
  });

  test("the first prompt stays when a later prompt (after /compact) is read", async () => {
    const nameMemory = new NameMemory();
    await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "Original prompt", source: "prompt" } });
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "After compact", source: "prompt" } }))
        ?.name,
    ).toBe("Original prompt");
  });

  test("a default name is shown when nothing else is known, but it is not remembered", async () => {
    const nameMemory = new NameMemory();
    expect(
      (await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "proj-91", source: "default" } }))?.name,
    ).toBe("proj-91");
    expect(await nameMemory.resolve({ id: item, chain: [item] })).toBeUndefined();
  });

  test("a chain finds the name of an older member", async () => {
    const nameMemory = new NameMemory();
    await nameMemory.resolve({ id: item, chain: [item], candidate: { name: "Shadcdn MCP", source: "ai" } });
    expect(
      (await nameMemory.resolve({ id: entry, chain: [item, entry], candidate: { name: "proj-91", source: "default" } }))
        ?.name,
    ).toBe("Shadcdn MCP");
    // now B has it too, so it survives when A is no longer in the chain
    expect((await nameMemory.resolve({ id: entry, chain: [entry] }))?.name).toBe("Shadcdn MCP");
  });

  test("it is saved and loaded again, and a bad or big file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "names-"));

    try {
      const file = join(dir, "sub", "names.json");
      await new NameMemory(file).resolve({
        id: item,
        chain: [item],
        candidate: { name: "Kept", source: "ai" },
        file: "/t/a.jsonl",
      });
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw[item]).toMatchObject({ name: "Kept", source: "ai", file: "/t/a.jsonl" });
      expect((await new NameMemory(file).resolve({ id: item, chain: [item] }))?.name).toBe("Kept");
      const bad = join(dir, "bad.json");
      await writeFile(bad, "{nope");
      expect(await new NameMemory(bad).resolve({ id: item, chain: [item] })).toBeUndefined();
      const big = join(dir, "big.json");
      await writeFile(big, JSON.stringify({ [item]: { name: "x".repeat(1024 * 1024), source: "ai", seen: 1 } }));
      expect(await new NameMemory(big).resolve({ id: item, chain: [item] })).toBeUndefined();
      const odd = join(dir, "odd.json");
      await writeFile(
        odd,
        JSON.stringify({
          [item]: { name: "ok", source: "bogus", seen: 1 },
          "../x": { name: "ok", source: "ai", seen: 1 },
          [entry]: { name: "y".repeat(500), source: "ai", seen: 1 },
        }),
      );
      const nameMemory = new NameMemory(odd);
      expect(await nameMemory.resolve({ id: item, chain: [item] })).toBeUndefined();
      expect((await nameMemory.resolve({ id: entry, chain: [entry] }))?.name.length).toBeLessThanOrEqual(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it keeps at most 1000 names and drops the oldest seen first", async () => {
    let value = 1_000_000;
    const nameMemory = new NameMemory(undefined, () => value++);
    for (let index = 0; index < 1002; index++)
      await nameMemory.resolve({ id: id(index), chain: [id(index)], candidate: { name: `n${index}`, source: "ai" } });
    expect(await nameMemory.resolve({ id: id(0), chain: [id(0)] })).toBeUndefined();
    expect(await nameMemory.resolve({ id: id(1), chain: [id(1)] })).toBeUndefined();
    expect((await nameMemory.resolve({ id: id(1001), chain: [id(1001)] }))?.name).toBe("n1001");
  });

  test("a listed session is seen again, so it outlives an idle one", async () => {
    let value = 1_000_000;
    const nameMemory = new NameMemory(undefined, () => value);
    await nameMemory.resolve({ id: id(0), chain: [id(0)], candidate: { name: "used", source: "ai" } });
    for (let index = 1; index < 1000; index++)
      await nameMemory.resolve({ id: id(index), chain: [id(index)], candidate: { name: `n${index}`, source: "ai" } });
    value += 10 * DAY;
    await nameMemory.resolve({ id: id(0), chain: [id(0)] });
    value += 1;
    await nameMemory.resolve({ id: id(2000), chain: [id(2000)], candidate: { name: "new", source: "ai" } });
    expect((await nameMemory.resolve({ id: id(0), chain: [id(0)] }))?.name).toBe("used");
    expect(await nameMemory.resolve({ id: id(1), chain: [id(1)] })).toBeUndefined();
  });

  describe("the sweep of names whose transcript is gone", () => {
    const fsOf = (present: Set<string>, errors: Record<string, string> = {}): TranscriptFs => ({
      readdir() {
        return Promise.resolve([]);
      },
      stat(path) {
        if (errors[path]) return Promise.reject(Object.assign(new Error(errors[path]), { code: errors[path] }));
        if (!present.has(path)) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
        return Promise.resolve({ mtimeMs: 1 });
      },
      async *lines() {},
    });

    test("it deletes the name of a missing transcript at the first call, then at most once a day", async () => {
      let value = 10 * DAY;
      const dir = await mkdtemp(join(tmpdir(), "names-"));

      try {
        const file = join(dir, "n.json");
        const seed = new NameMemory(file, () => value);
        await seed.resolve({ id: item, chain: [item], candidate: { name: "Gone", source: "ai" }, file: "/t/a.jsonl" });
        await seed.resolve({
          id: entry,
          chain: [entry],
          candidate: { name: "Stays", source: "ai" },
          file: "/t/b.jsonl",
        });
        const present = new Set(["/t/b.jsonl"]);
        const nameMemory = new NameMemory(file, () => value);
        nameMemory.useFs(fsOf(present));
        expect(await nameMemory.resolve({ id: item, chain: [item] })).toBeUndefined();
        expect((await nameMemory.resolve({ id: entry, chain: [entry] }))?.name).toBe("Stays");
        expect(JSON.parse(await readFile(file, "utf8"))[item]).toBeUndefined();
        // within a day a new gap is not swept; after a day it is
        present.delete("/t/b.jsonl");
        value += DAY / 2;
        expect((await nameMemory.resolve({ id: entry, chain: [entry] }))?.name).toBe("Stays");
        value += DAY;
        expect(await nameMemory.resolve({ id: entry, chain: [entry] })).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("an error other than a missing file keeps the name", async () => {
      const nameMemory = new NameMemory(undefined, () => 10 * DAY);
      await nameMemory.resolve({
        id: item,
        chain: [item],
        candidate: { name: "Kept", source: "ai" },
        file: "/t/a.jsonl",
      });
      nameMemory.useFs(fsOf(new Set(), { "/t/a.jsonl": "EACCES" }));
      (nameMemory as any).lastSweep = 0;
      expect((await nameMemory.resolve({ id: item, chain: [item] }))?.name).toBe("Kept");
    });
  });
});

describe("the catalog uses the name memory", () => {
  const FILE = "/h/.claude/projects/-work-proj/" + item + ".jsonl";
  const rec = (value: object) => JSON.stringify({ cwd: "/work/proj", timestamp: "2026-01-01T00:00:00.000Z", ...value });
  const user = (text: string, extra: object = {}) => rec({ type: "user", message: { content: text }, ...extra });

  function fsOf(lines: () => string[]): TranscriptFs {
    return {
      readdir(dir) {
        return Promise.resolve(dir === "/h/.claude/projects" ? ["-work-proj"] : [item + ".jsonl"]);
      },
      stat(path) {
        if (path !== FILE) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
        return Promise.resolve({ mtimeMs: Date.now(), size: lines().join("\n").length });
      },
      async *lines() {
        for (const line of lines()) yield line;
      },
      tail() {
        return Promise.resolve(lines());
      },
    };
  }

  test.skipIf(process.platform === "win32")("a name read before /compact survives it", async () => {
    let lines = [user("Fix the login bug")];
    const cat = new SessionCatalog({ fs: fsOf(() => lines) });
    const inst = cat.instance({ path: "/work/proj", home: "/h" });
    expect((await inst.list())[0].name).toBe("Fix the login bug");
    lines = [
      user("This session is being continued from a previous conversation.", { isCompactSummary: true }),
      user("now add tests"),
    ];
    expect((await inst.list())[0].name).toBe("Fix the login bug");
  });

  test.skipIf(process.platform === "win32")(
    "a title found later replaces the remembered prompt, and a default live name does not",
    async () => {
      let lines = [user("Fix the login bug")];
      const cat = new SessionCatalog({
        fs: fsOf(() => lines),
        live: () => Promise.resolve(new Map([[item, { remoteControl: true, name: "proj-91", nameIsDefault: true }]])),
      });
      const inst = cat.instance({ path: "/work/proj", home: "/h" });
      expect((await inst.list())[0].name).toBe("Fix the login bug");
      lines = [user("later"), rec({ type: "ai-title", aiTitle: "Login fix" })];
      expect((await inst.list())[0].name).toBe("Login fix");
      lines = [user("even later")];
      expect((await inst.list())[0].name).toBe("Login fix");
    },
  );
});
