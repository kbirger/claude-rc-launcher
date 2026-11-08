import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/instances";
import { isTrustedWin, trustKey, windowsTrust } from "../src/win/trust";

const trusted = (extra: object = {}) => ({ hasTrustDialogAccepted: true, ...extra });

describe("isTrustedWin", () => {
  test("a backslash path is looked up in its forward-slash form", () => {
    const doc = { projects: { "C:/work/proj": trusted() } };
    expect(isTrustedWin(doc, "C:\\work\\proj")).toBe(true);
    expect(isTrustedWin(doc, "C:/work/proj")).toBe(true);
  });

  test("a backslash-only entry does not count: claude ignores it", () => {
    expect(isTrustedWin({ projects: { "C:\\work\\proj": trusted() } }, "C:\\work\\proj")).toBe(false);
  });

  test("the case must match exactly", () => {
    const doc = { projects: { "c:/work/proj": trusted() } };
    expect(isTrustedWin(doc, "C:\\work\\proj")).toBe(false);
  });

  test("a trusted parent covers a child, up to the drive root", () => {
    expect(isTrustedWin({ projects: { "C:/work": trusted() } }, "C:\\work\\a\\b")).toBe(true);
    expect(isTrustedWin({ projects: { "C:/": trusted() } }, "C:\\work\\a")).toBe(true);
    expect(isTrustedWin({ projects: { "C:/other": trusted() } }, "C:\\work\\a")).toBe(false);
    expect(isTrustedWin({ projects: { "D:/work": trusted() } }, "C:\\work")).toBe(false);
  });

  test("an entry without hasTrustDialogAccepted true does not count", () => {
    expect(isTrustedWin({ projects: { "C:/w": { hasTrustDialogAccepted: false } } }, "C:\\w")).toBe(false);
    expect(isTrustedWin({ projects: { "C:/w": {} } }, "C:\\w")).toBe(false);
    expect(isTrustedWin({ projects: { "C:/w": "yes" } }, "C:\\w")).toBe(false);
  });

  test("a missing or odd document trusts nothing", () => {
    for (const doc of [null, undefined, [], "x", {}, { projects: null }, { projects: [] }]) expect(isTrustedWin(doc, "C:\\w")).toBe(false);
  });

  test("a prototype key is not an entry", () => {
    expect(isTrustedWin({ projects: {} }, "C:\\constructor")).toBe(false);
  });
});

test("trustKey", () => {
  expect(trustKey("C:\\Users\\kir\\proj")).toBe("C:/Users/kir/proj");
  expect(trustKey("C:/already/fine")).toBe("C:/already/fine");
});

describe("windowsTrust", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "wtrust-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  const file = () => join(home, ".claude.json");
  const read = async () => JSON.parse(await readFile(file(), "utf8"));

  test("a missing file trusts nothing, and add creates it with the forward-slash key", async () => {
    const t = windowsTrust();
    expect((await t.checker(home))("C:\\w\\p")).toBe(false);
    await t.add({ home }, "C:\\w\\p");
    expect(await read()).toEqual({ projects: { "C:/w/p": { hasTrustDialogAccepted: true } } });
    expect((await t.checker(home))("C:\\w\\p")).toBe(true);
  });

  test("add keeps other keys and other fields of the entry, and leaves no temporary file", async () => {
    await writeFile(file(), JSON.stringify({ userID: "u", projects: { "C:/w/p": { allowedTools: ["x"] }, "C:/o": trusted() } }));
    await windowsTrust().add({ home }, "C:\\w\\p");
    expect(await read()).toEqual({ userID: "u", projects: { "C:/w/p": { allowedTools: ["x"], hasTrustDialogAccepted: true }, "C:/o": trusted() } });
    expect(await readdir(home)).toEqual([".claude.json"]);
  });

  test("a file that is not valid JSON is refused and left alone", async () => {
    await writeFile(file(), "{ nope");
    await expect(windowsTrust().add({ home }, "C:\\w")).rejects.toBeInstanceOf(HttpError);
    expect(await readFile(file(), "utf8")).toBe("{ nope");
    expect(await readdir(home)).toEqual([".claude.json"]);
  });

  test("a file that is not a JSON object is refused", async () => {
    await writeFile(file(), "[1]");
    await expect(windowsTrust().add({ home }, "C:\\w")).rejects.toThrow("not a JSON object");
  });

  test("a file that is too large is refused", async () => {
    await writeFile(file(), JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }));
    await expect(windowsTrust().add({ home }, "C:\\w")).rejects.toThrow("too large");
  });

  test("parallel adds all land", async () => {
    const t = windowsTrust();
    await Promise.all(["a", "b", "c", "d", "e"].map((n) => t.add({ home }, `C:\\w\\${n}`)));
    expect(Object.keys((await read()).projects).sort()).toEqual(["C:/w/a", "C:/w/b", "C:/w/c", "C:/w/d", "C:/w/e"]);
  });
});
