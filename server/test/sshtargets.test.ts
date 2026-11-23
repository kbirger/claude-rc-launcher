import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetError, TargetStore, authorizedKeysLine, installNotes } from "../src/sshtargets";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sshtargets-"));
  file = join(dir, "ssh", "targets.json");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const input = {
  id: "nas",
  address: "192.168.1.20",
  port: 22,
  account: "root",
  systemType: "linux" as const,
  nodes: ["pve"],
};

async function status(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof TargetError ? error.status : -1;
  }

  return undefined;
}

describe("TargetStore", () => {
  test("add rejects an id that does not match the pattern", async () => {
    const store = new TargetStore();
    expect(await status(store.add({ ...input, id: "Bad Id" }))).toBe(400);
    expect(await status(store.add({ ...input, id: "" }))).toBe(400);
    expect(store.list()).toEqual([]);
  });

  test("add rejects a duplicate id with 409", async () => {
    const store = new TargetStore();
    await store.add(input);
    expect(await status(store.add(input))).toBe(409);
    expect(store.list()).toHaveLength(1);
  });

  test("add rejects a port outside 1 to 65535", async () => {
    const store = new TargetStore();

    for (const port of [0, 65536, -1, 22.5, Number.NaN]) {
      expect(await status(store.add({ ...input, port }))).toBe(400);
    }

    expect((await store.add({ ...input, port: 65535 })).port).toBe(65535);
  });

  test("add rejects a managedHost that is not a host id", async () => {
    const store = new TargetStore();
    expect(await status(store.add({ ...input, managedHost: "Not A Host" }))).toBe(400);
    expect((await store.add({ ...input, managedHost: "pve" })).managedHost).toBe("pve");
  });

  test("add rejects bad input for the other fields", async () => {
    const store = new TargetStore();
    expect(await status(store.add({ ...input, address: "" }))).toBe(400);
    expect(await status(store.add({ ...input, address: "a b" }))).toBe(400);
    expect(await status(store.add({ ...input, account: "" }))).toBe(400);
    expect(await status(store.add({ ...input, systemType: "amiga" as never }))).toBe(400);
    expect(await status(store.add({ ...input, nodes: ["Bad Node"] }))).toBe(400);
  });

  test("a new target is draft", async () => {
    const store = new TargetStore();
    const target = await store.add(input);
    expect(target.state).toBe("draft");
    expect(target.hostKey).toBeUndefined();
    expect(target.keyFingerprint).toBeUndefined();
  });

  test("a change to a returned target does not reach the store", async () => {
    const store = new TargetStore();
    const target = await store.add(input);
    target.nodes.push("evil");
    target.state = "ready";
    expect(store.get("nas")?.nodes).toEqual(["pve"]);
    expect(store.get("nas")?.state).toBe("draft");
  });

  test("setters change one target and refuse an unknown id with 404", async () => {
    const store = new TargetStore();
    await store.add(input);
    await store.setKeyFingerprint("nas", "SHA256:abc");
    await store.setHostKey("nas", "ssh-ed25519 AAAA");
    await store.setState("nas", "ready");
    expect(store.get("nas")).toMatchObject({
      keyFingerprint: "SHA256:abc",
      hostKey: "ssh-ed25519 AAAA",
      state: "ready",
    });
    expect(await status(store.setState("nope", "ready"))).toBe(404);
    expect(await status(store.setKeyFingerprint("nope", "x"))).toBe(404);
    expect(await status(store.setHostKey("nope", "x"))).toBe(404);
    expect(await status(store.remove("nope"))).toBe(404);
    expect(await status(store.setState("nas", "bogus" as never))).toBe(400);
    expect(await status(store.setHostKey("nas", "line one\nline two"))).toBe(400);
  });

  test("remove deletes the target", async () => {
    const store = new TargetStore();
    await store.add(input);
    await store.remove("nas");
    expect(store.get("nas")).toBeUndefined();
  });

  test("setNodeAccess rejects an empty source address when enabled", async () => {
    const store = new TargetStore();
    expect(await status(store.setNodeAccess("pve", { enabled: true, sourceAddress: "" }))).toBe(400);
    expect(await status(store.setNodeAccess("pve", { enabled: true, sourceAddress: '1.2.3.4",command="x' }))).toBe(400);
    expect(await status(store.setNodeAccess("Bad Id", { enabled: false, sourceAddress: "" }))).toBe(400);
    expect(store.nodeAccess("pve")).toBeUndefined();
    await store.setNodeAccess("pve", { enabled: true, sourceAddress: "192.168.1.103" });
    expect(store.nodeAccess("pve")).toEqual({ enabled: true, sourceAddress: "192.168.1.103" });
    await store.setNodeAccess("pve", { enabled: false, sourceAddress: "" });
    expect(store.nodeAccess("pve")).toEqual({ enabled: false, sourceAddress: "" });
  });

  test("data survives a reload from the file", async () => {
    const store = new TargetStore(file);
    await store.add({ ...input, managedHost: "pve" });
    await store.setKeyFingerprint("nas", "SHA256:abc");
    await store.setHostKey("nas", "ssh-ed25519 AAAA");
    await store.setState("nas", "ready");
    await store.setNodeAccess("pve", { enabled: true, sourceAddress: "192.168.1.103" });

    const again = new TargetStore(file);
    expect(again.list()).toEqual(store.list());
    expect(again.get("nas")).toMatchObject({ managedHost: "pve", state: "ready", hostKey: "ssh-ed25519 AAAA" });
    expect(again.nodeAccess("pve")).toEqual({ enabled: true, sourceAddress: "192.168.1.103" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("a damaged file is an empty store", async () => {
    await Bun.write(file, "{not json");
    const store = new TargetStore(file);
    expect(store.list()).toEqual([]);
    await store.add(input);
    const saved = JSON.parse(await readFile(file, "utf8")) as { version: number };
    expect(saved.version).toBe(1);
  });

  test("a failed write leaves the state as it was", async () => {
    // The parent of the file is a regular file, so the folder cannot be made.
    await Bun.write(join(dir, "blocker"), "x");
    const store = new TargetStore(join(dir, "blocker", "targets.json"));
    expect(await status(store.add(input))).toBe(-1);
    expect(store.list()).toEqual([]);
  });

  test("entries with a bad id or type in the file are skipped", async () => {
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        targets: {
          good: { ...input, id: "good", state: "ready" },
          "Bad Id": { ...input, id: "Bad Id", state: "ready" },
          oddtype: { ...input, id: "oddtype", systemType: "amiga", state: "ready" },
          oddport: { ...input, id: "oddport", port: 0, state: "ready" },
        },
      }),
    );
    expect(new TargetStore(file).list().map((target) => target.id)).toEqual(["good"]);
  });
});

describe("authorizedKeysLine", () => {
  const key = "ssh-ed25519 AAAAC3Nza claude-rc:nas";

  test("authorizedKeysLine puts from and restrict before the key", () => {
    expect(authorizedKeysLine(key, ["192.168.1.103"])).toBe(`from="192.168.1.103",restrict ${key}`);
    expect(authorizedKeysLine(key, ["10.0.0.1", "10.0.0.2"])).toBe(`from="10.0.0.1,10.0.0.2",restrict ${key}`);
  });

  test("authorizedKeysLine with no source address throws", () => {
    expect(() => authorizedKeysLine(key, [])).toThrow();
    expect(() => authorizedKeysLine(key, [""])).toThrow();
  });

  test("authorizedKeysLine refuses an address that could add an option", () => {
    expect(() => authorizedKeysLine(key, ['1.2.3.4",command="x'])).toThrow();
    expect(() => authorizedKeysLine(key, ["1.2.3.4 extra"])).toThrow();
    expect(() => authorizedKeysLine("ssh-ed25519 AAAA\nssh-rsa BBBB", ["1.2.3.4"])).toThrow();
  });
});

describe("installNotes", () => {
  test("installNotes for dropbear names the Authorized Keys page", () => {
    expect(installNotes("dropbear").join("\n")).toContain("Authorized Keys");
  });

  test("installNotes for windows names administrators_authorized_keys", () => {
    expect(installNotes("windows").join("\n")).toContain("administrators_authorized_keys");
  });

  test("installNotes for linux and synology name authorized_keys and the modes", () => {
    for (const type of ["linux", "synology"] as const) {
      const text = installNotes(type).join("\n");
      expect(text).toContain("~/.ssh/authorized_keys");
      expect(text).toContain("700");
      expect(text).toContain("600");
    }
  });
});
