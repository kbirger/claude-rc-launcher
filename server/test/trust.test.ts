import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTrust, isTrustedIn } from "../src/trust";
import { HttpError } from "../src/instances";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "trust-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const file = () => join(home, ".claude.json");
const isRoot = process.getuid?.() === 0;

describe("isTrustedIn", () => {
  test("exact, parent and root match", () => {
    const doc = { projects: { "/opt": { hasTrustDialogAccepted: true } } };
    expect(isTrustedIn(doc, "/opt")).toBe(true);
    expect(isTrustedIn(doc, "/opt/app/x")).toBe(true);
    expect(isTrustedIn(doc, "/opt2")).toBe(false);
    expect(isTrustedIn(doc, "/")).toBe(false);
    expect(isTrustedIn({ projects: { "/": { hasTrustDialogAccepted: true } } }, "/a/b")).toBe(true);
  });

  test("false values and bad shapes", () => {
    expect(isTrustedIn({ projects: { "/opt": { hasTrustDialogAccepted: "yes" } } }, "/opt")).toBe(false);
    expect(isTrustedIn({ projects: { "/opt": { hasTrustDialogAccepted: false } } }, "/opt")).toBe(false);
    expect(isTrustedIn({ projects: [] }, "/opt")).toBe(false);
    expect(isTrustedIn(null, "/opt")).toBe(false);
    expect(isTrustedIn({ projects: { "/opt": null } }, "/opt")).toBe(false);
  });
});

describe("checker", () => {
  test("missing file means untrusted", async () => {
    const check = await fileTrust().checker(home);
    expect(check("/opt")).toBe(false);
  });

  test("invalid JSON means untrusted", async () => {
    await writeFile(file(), "{nope");
    const check = await fileTrust().checker(home);
    expect(check("/opt")).toBe(false);
  });

  test("reads trusted folders", async () => {
    await writeFile(file(), JSON.stringify({ projects: { "/opt": { hasTrustDialogAccepted: true } } }));
    const check = await fileTrust().checker(home);
    expect(check("/opt/x")).toBe(true);
  });
});

describe("add", () => {
  test("creates the file with mode 0600 and calls chown", async () => {
    const calls: [string, number, number][] = [];
    const store = fileTrust({ chown: async (p, u, g) => { calls.push([p, u, g]); } });
    await store.add({ home, uid: 1234, gid: 5678 }, "/opt/app");
    const doc = JSON.parse(await readFile(file(), "utf8"));
    expect(doc.projects["/opt/app"].hasTrustDialogAccepted).toBe(true);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    if (isRoot) expect(calls.length).toBe(1);
    for (const [p, u, g] of calls) {
      expect(p.startsWith(home)).toBe(true);
      expect([u, g]).toEqual([1234, 5678]);
    }
    expect((await fileTrust().checker(home))("/opt/app/sub")).toBe(true);
  });

  test("keeps other keys and the file mode", async () => {
    await writeFile(file(), JSON.stringify({ theme: "dark", projects: { "/x": { allowedTools: ["a"] } } }));
    await chmod(file(), 0o640);
    await fileTrust({ chown: async () => {} }).add({ home, uid: 1, gid: 1 }, "/x");
    const doc = JSON.parse(await readFile(file(), "utf8"));
    expect(doc.theme).toBe("dark");
    expect(doc.projects["/x"].allowedTools).toEqual(["a"]);
    expect(doc.projects["/x"].hasTrustDialogAccepted).toBe(true);
    expect((await stat(file())).mode & 0o777).toBe(0o640);
  });

  test("invalid JSON throws HttpError 500 and leaves the file unchanged", async () => {
    await writeFile(file(), "{nope");
    const err = await fileTrust({ chown: async () => {} }).add({ home, uid: 1, gid: 1 }, "/x").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect(await readFile(file(), "utf8")).toBe("{nope");
    expect(await readdir(home)).toEqual([".claude.json"]);
  });

  test("leaves no temp file behind", async () => {
    await fileTrust({ chown: async () => {} }).add({ home, uid: 1, gid: 1 }, "/x");
    expect(await readdir(home)).toEqual([".claude.json"]);
  });
});
