import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HOST_ID_RE } from "../src/hostid";

describe("HOST_ID_RE", () => {
  test("accepts lower-case ids of 1 to 32 characters", () => {
    for (const id of ["a", "nas", "pi-2", "0abc", "a".repeat(32)]) expect([id, HOST_ID_RE.test(id)]).toEqual([id, true]);
  });
  test("rejects everything else", () => {
    for (const id of ["", "-a", "A", "a_b", "a.b", "a b", "a/b", "a\n", "a".repeat(33), "é"]) expect([id, HOST_ID_RE.test(id)]).toEqual([id, false]);
  });
});

// One definition only: the config loader, the forwarding router, the registry, the admin API and the CLI all read it.
describe("the host id format has a single definition", () => {
  const root = path.join(import.meta.dir, "../..");
  const files = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  test("no source file repeats the pattern", () => {
    const pattern = "[a-z0-9][a-z0-9-]{0,31}";
    const hits = [...files("server/src"), ...files("cli/src")].filter((f) => readFileSync(path.join(root, f), "utf8").includes(pattern));
    expect(hits).toEqual([path.join("server/src", "hostid.ts")]);
  });
});
