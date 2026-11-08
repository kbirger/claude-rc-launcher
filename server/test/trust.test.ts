import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { link, mkdtemp, readdir, readFile, readlink, writeFile, rm, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTrust, isTrustedIn } from "../src/trust";
import { HttpError } from "../src/instances";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "trust-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const file = () => join(home, ".claude.json");

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
    const calls: [number, number][] = [];
    const store = fileTrust({ isRoot: () => true, chown: async (_fh, u, g) => { calls.push([u, g]); } });
    await store.add({ home, uid: 1234, gid: 5678 }, "/opt/app");
    const doc = JSON.parse(await readFile(file(), "utf8"));
    expect(doc.projects["/opt/app"].hasTrustDialogAccepted).toBe(true);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([[1234, 5678]]);
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

  test("an existing file is chowned to the given user, not to its current owner", async () => {
    await writeFile(file(), "{}");
    const calls: [number, number][] = [];
    await fileTrust({ isRoot: () => true, chown: async (_fh, u, g) => { calls.push([u, g]); } })
      .add({ home, uid: 4321, gid: 8765 }, "/x");
    expect(calls).toEqual([[4321, 8765]]);
  });

  test("as root with no ids given, chown is skipped for an existing file", async () => {
    await writeFile(file(), "{}");
    let n = 0;
    await fileTrust({ isRoot: () => true, chown: async () => { n++; } }).add({ home }, "/x");
    expect(n).toBe(0);
    expect((await fileTrust().checker(home))("/x")).toBe(true);
  });

  test("chown is skipped when not root", async () => {
    let n = 0;
    await fileTrust({ isRoot: () => false, chown: async () => { n++; } }).add({ home, uid: 1, gid: 1 }, "/x");
    expect(n).toBe(0);
  });

  test("valid JSON that is not an object throws 500 and leaves the file unchanged", async () => {
    for (const text of ["[]", '"x"', "null"]) {
      await writeFile(file(), text);
      const err = await fileTrust({ chown: async () => {} }).add({ home, uid: 1, gid: 1 }, "/x").catch((e) => e);
      expect((err as HttpError).status).toBe(500);
      expect(await readFile(file(), "utf8")).toBe(text);
    }
  });

  test("failed chown removes the temp file and surfaces the original error", async () => {
    await writeFile(file(), "{}");
    const boom = new Error("chown boom");
    const err = await fileTrust({ isRoot: () => true, chown: async () => { throw boom; } })
      .add({ home, uid: 1, gid: 1 }, "/x").catch((e) => e);
    expect(err).toBe(boom);
    expect(await readdir(home)).toEqual([".claude.json"]);
    expect(await readFile(file(), "utf8")).toBe("{}");
  });


  test("parallel adds for one home both land", async () => {
    const store = fileTrust({ chown: async () => {} });
    await Promise.all(["/a", "/b", "/c", "/d"].map((p) => store.add({ home, uid: 1, gid: 1 }, p)));
    const check = await store.checker(home);
    expect(["/a", "/b", "/c", "/d"].map(check)).toEqual([true, true, true, true]);
  });
});

describe("a .claude.json that is not a regular file", () => {
  let other: string;
  beforeEach(async () => { other = await mkdtemp(join(tmpdir(), "trust-other-")); });
  afterEach(async () => { await rm(other, { recursive: true, force: true }); });

  /** add must fail with 500, write nothing, and leave the link and its target as they were. */
  async function expectRefused(store = fileTrust({ isRoot: () => true, chown: async () => { throw new Error("chown must not run"); } })) {
    const err = await store.add({ home, uid: 1, gid: 1 }, "/opt").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect(await readdir(home)).toEqual([".claude.json"]);
    return err as HttpError;
  }

  test("a symlink to a regular file is not read and not replaced", async () => {
    const target = join(other, "root.json");
    const text = JSON.stringify({ secret: "s", projects: { "/opt": { hasTrustDialogAccepted: true } } });
    await writeFile(target, text);
    await symlink(target, file());
    expect((await fileTrust().checker(home))("/opt")).toBe(false);
    const err = await expectRefused();
    expect(err.message).toContain("symlink");
    expect(await readlink(file())).toBe(target);
    expect(await readFile(target, "utf8")).toBe(text);
  });

  test("a hard link to another file is not read and not replaced", async () => {
    const target = join(other, "root.json");
    const text = JSON.stringify({ secret: "s", projects: { "/opt": { hasTrustDialogAccepted: true } } });
    await writeFile(target, text);
    try { await link(target, file()); } catch { return; } // the temp dirs are on different file systems
    expect((await fileTrust().checker(home))("/opt")).toBe(false);
    const err = await expectRefused();
    expect(err.message).toContain("more than one link");
    expect(await readFile(target, "utf8")).toBe(text);
    expect((await stat(target)).nlink).toBe(2);
  });

  test("a symlink to /dev/zero is refused without reading it", async () => {
    await symlink("/dev/zero", file());
    expect((await fileTrust().checker(home))("/opt")).toBe(false);
    await expectRefused();
    expect(await readlink(file())).toBe("/dev/zero");
  }, 2000);

  test("a FIFO is refused without blocking", async () => {
    const mkfifo = Bun.which("mkfifo");
    if (!mkfifo) return; // no mkfifo on this system: nothing to test
    expect(Bun.spawnSync([mkfifo, file()]).exitCode).toBe(0);
    expect((await fileTrust().checker(home))("/opt")).toBe(false);
    const err = await expectRefused();
    expect(err.message).toContain("not a regular file");
    expect((await stat(file())).isFIFO()).toBe(true);
  }, 2000);

  test("a directory is refused", async () => {
    await (await import("node:fs/promises")).mkdir(file());
    expect((await fileTrust().checker(home))("/opt")).toBe(false);
    const err = await expectRefused();
    expect(err.message).toContain("not a regular file");
  });

  test("a file over 1 MiB is refused and left unchanged", async () => {
    const text = JSON.stringify({ projects: { "/opt": { hasTrustDialogAccepted: true } }, pad: "x".repeat(1024 * 1024) });
    await writeFile(file(), text);
    expect((await fileTrust().checker(home))("/opt")).toBe(false);
    const err = await expectRefused();
    expect(err.message).toContain("too large");
    expect(await readFile(file(), "utf8")).toBe(text);
  });
});
