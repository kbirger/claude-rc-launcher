import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TargetError,
  TargetStore,
  authorizedKeysLine,
  hasProvisioner,
  installNotes,
  isKeyFile,
  keyFileProblem,
} from "../src/sshtargets";

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

  test("add refuses an id in every state, and the id is free again after remove", async () => {
    const store = new TargetStore();
    await store.add({ ...input, address: "10.0.0.1" });

    for (const state of ["draft", "ready", "disabled"] as const) {
      await store.setState("nas", state);
      expect(await status(store.add(input))).toBe(409);
    }

    await store.setKeyFingerprint("nas", "SHA256:old");
    await store.remove("nas");
    const again = await store.add({ ...input, address: "10.0.0.2" });
    expect(again).toMatchObject({ id: "nas", address: "10.0.0.2", state: "draft" });
    expect(store.get("nas")?.keyFingerprint).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  test("the state retired does not exist any more", async () => {
    const store = new TargetStore();
    await store.add(input);
    expect(await status(store.setState("nas", "retired" as never))).toBe(400);
  });

  test("records with the old state retired are dropped when the store loads", async () => {
    const record = (id: string, state: string) => ({
      id,
      address: "10.0.0.5",
      port: 22,
      account: "root",
      systemType: "linux",
      nodes: ["pve"],
      state,
    });
    await mkdir(join(dir, "ssh"), { recursive: true });
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        targets: { old: record("old", "retired"), keep: record("keep", "ready") },
        nodes: {},
      }),
    );
    const store = new TargetStore(file);
    expect(store.list().map((target) => target.id)).toEqual(["keep"]);
    expect(store.get("old")).toBeUndefined();
    // The id is free, and the next write drops the old record from the file.
    await store.add({ ...input, id: "old" });
    const saved = JSON.parse(await readFile(file, "utf8")) as { targets: Record<string, { state: string }> };
    expect(saved.targets.old.state).toBe("draft");
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
    expect(await status(store.add({ ...input, address: "-v" }))).toBe(400);
    expect(await status(store.add({ ...input, account: "-oProxyCommand=id" }))).toBe(400);
    expect((await store.add({ ...input, id: "v6", address: "::1" })).address).toBe("::1");
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

  test("setNodes replaces the list, keeps the other fields and survives a reload", async () => {
    const store = new TargetStore(file);
    await store.add(input);
    await store.setKeyFingerprint("nas", "SHA256:abc");
    await store.setState("nas", "ready");
    const before = store.get("nas");
    await store.setNodes("nas", ["a", "b"]);
    expect(store.get("nas")).toEqual({ ...before!, nodes: ["a", "b"] });
    expect(before?.nodes).toEqual(["pve"]);
    expect(new TargetStore(file).get("nas")?.nodes).toEqual(["a", "b"]);
    await store.setNodes("nas", []);
    expect(new TargetStore(file).get("nas")?.nodes).toEqual([]);
  });

  test("setNodes copies the list it gets and refuses a bad list", async () => {
    const store = new TargetStore();
    await store.add(input);
    const list = ["a"];
    await store.setNodes("nas", list);
    list.push("b");
    expect(store.get("nas")?.nodes).toEqual(["a"]);
    const returned = store.get("nas")!;
    returned.nodes.push("x");
    expect(store.get("nas")?.nodes).toEqual(["a"]);
    expect(await status(store.setNodes("nope", ["a"]))).toBe(404);
    expect(await status(store.setNodes("nas", ["a", "a"]))).toBe(400);
    expect(await status(store.setNodes("nas", ["../x"]))).toBe(400);
    expect(await status(store.setNodes("nas", "a" as never))).toBe(400);
    expect(await status(store.setNodes("nas", [5] as never))).toBe(400);
    expect(
      await status(
        store.setNodes(
          "nas",
          Array.from({ length: 201 }, (_, index) => `n${index}`),
        ),
      ),
    ).toBe(400);
    expect(store.get("nas")?.nodes).toEqual(["a"]);
  });

  test("a failed write of setNodes leaves the nodes as they were", async () => {
    const store = new TargetStore(join(dir, "ssh", "targets.json"));
    await store.add(input);
    // Replace the folder of the file with a regular file, so the next write fails.
    await rm(join(dir, "ssh"), { recursive: true, force: true });
    await Bun.write(join(dir, "ssh"), "x");
    expect(await status(store.setNodes("nas", ["a", "b"]))).toBe(-1);
    expect(store.get("nas")?.nodes).toEqual(["pve"]);
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

describe("key file", () => {
  test("isKeyFile takes authorized_keys and names that start with it, and nothing else", () => {
    for (const good of [
      "authorized_keys",
      "authorized_keys2",
      "authorized_keys.claude-rc",
      `authorized_keys${"a".repeat(48)}`,
    ])
      expect(isKeyFile(good)).toBe(true);
    const bad = [
      "../x",
      "authorized_keys/../x",
      "authorized_keys/x",
      "known_hosts",
      "id_ed25519",
      "xauthorized_keys",
      "authorized_keys ",
      "authorized_keys\n",
      "authorized_keys$x",
      `authorized_keys${"a".repeat(49)}`,
      "",
      5,
      undefined,
    ];
    for (const value of bad) expect(isKeyFile(value)).toBe(false);
  });

  test("keyFileProblem allows a key file for a managed linux or synology target only", () => {
    expect(keyFileProblem(undefined, "windows", false)).toBeUndefined();
    expect(keyFileProblem("authorized_keys2", "linux", true)).toBeUndefined();
    expect(keyFileProblem("authorized_keys2", "synology", true)).toBeUndefined();
    expect(keyFileProblem("authorized_keys2", "dropbear", true)).toBeDefined();
    expect(keyFileProblem("authorized_keys2", "windows", true)).toBeDefined();
    expect(keyFileProblem("authorized_keys2", "linux", false)).toBeDefined();
    expect(keyFileProblem("../x", "linux", true)).toBeDefined();
  });

  test("add refuses a bad key file, an external target with one, and dropbear and windows with one", async () => {
    const store = new TargetStore();
    const managed = { ...input, managedHost: "pve" };
    for (const keyFile of ["../x", "authorized_keys/../x", "known_hosts", `authorized_keys${"a".repeat(49)}`])
      expect(await status(store.add({ ...managed, keyFile }))).toBe(400);
    expect(await status(store.add({ ...input, keyFile: "authorized_keys2" }))).toBe(400);
    for (const systemType of ["dropbear", "windows"] as const)
      expect(await status(store.add({ ...managed, systemType, keyFile: "authorized_keys2" }))).toBe(400);
    expect(store.list()).toEqual([]);
  });

  test("a key file survives a reload, and a target without one has none", async () => {
    const store = new TargetStore(file);
    await store.add({ ...input, managedHost: "pve", keyFile: "authorized_keys2" });
    await store.add({ ...input, id: "plain", managedHost: "pve", systemType: "synology" });
    expect(store.get("nas")?.keyFile).toBe("authorized_keys2");
    expect(store.get("plain")).not.toHaveProperty("keyFile");

    const again = new TargetStore(file);
    expect(again.get("nas")?.keyFile).toBe("authorized_keys2");
    expect(again.get("plain")).not.toHaveProperty("keyFile");
    expect(again.list()).toEqual(store.list());
  });

  test("a record with a bad key file in the file is skipped on load", async () => {
    const store = new TargetStore(file);
    await store.add({ ...input, managedHost: "pve", keyFile: "authorized_keys2" });
    await store.add({ ...input, id: "other", managedHost: "pve" });
    const text = (await readFile(file, "utf8")).replace('"authorized_keys2"', '"../x"');
    await Bun.write(file, text);
    expect(new TargetStore(file).list().map((target) => target.id)).toEqual(["other"]);
  });
});

describe("the provisioner fields", () => {
  const value = { fingerprint: "SHA256:abc", script: "/usr/local/sbin/claude-rc-provisioner", source: "10.0.0.2" };

  test("setProvisioner stores the three fields, and an empty value clears them", async () => {
    const store = new TargetStore(file);
    await store.add(input);
    expect(hasProvisioner(store.get("nas") as never)).toBe(false);
    await store.setProvisioner("nas", value);
    const target = store.get("nas");
    expect(target?.provisionerFingerprint).toBe(value.fingerprint);
    expect(target?.provisionerScript).toBe(value.script);
    expect(target?.provisionerSource).toBe(value.source);
    expect(hasProvisioner(target as never)).toBe(true);
    expect(new TargetStore(file).get("nas")?.provisionerScript).toBe(value.script);

    await store.setProvisioner("nas", undefined);
    expect(hasProvisioner(store.get("nas") as never)).toBe(false);
    expect(Object.keys(store.get("nas") ?? {})).not.toContain("provisionerScript");
    expect(await status(store.setProvisioner("nope", value))).toBe(404);
  });

  test("a file without them loads", async () => {
    const old = new TargetStore(file);
    await old.add(input);
    const reloaded = new TargetStore(file);
    expect(reloaded.get("nas")?.provisionerFingerprint).toBeUndefined();
    expect(hasProvisioner(reloaded.get("nas") as never)).toBe(false);
  });

  test("setProvisioner refuses a script path that SCRIPT_PATH_RE refuses", async () => {
    const store = new TargetStore();
    await store.add(input);
    for (const script of ["relative/path", "/with space", '/quo"te', "/a\nb", "", "/x;rm"])
      expect(await status(store.setProvisioner("nas", { ...value, script }))).toBe(400);
    expect(await status(store.setProvisioner("nas", { ...value, fingerprint: "a\nb" }))).toBe(400);
    expect(await status(store.setProvisioner("nas", { ...value, source: "" }))).toBe(400);
    expect(hasProvisioner(store.get("nas") as never)).toBe(false);
  });

  test("a windows target takes no provisioner, and the fields of one in a file are dropped", async () => {
    const store = new TargetStore(file);
    await store.add({ ...input, id: "win", systemType: "windows" });
    expect(await status(store.setProvisioner("win", value))).toBe(400);
    await store.add({ ...input, id: "man", managedHost: "pve" });

    const json = JSON.parse(await readFile(file, "utf8")) as { targets: Record<string, Record<string, unknown>> };
    const fields = {
      provisionerFingerprint: value.fingerprint,
      provisionerScript: value.script,
      provisionerSource: value.source,
    };
    json.targets.win = { ...json.targets.win, ...fields };
    json.targets.man = { ...json.targets.man, ...fields };
    await Bun.write(file, JSON.stringify(json));
    const reloaded = new TargetStore(file);
    expect(hasProvisioner(reloaded.get("win") as never)).toBe(false);
    expect(hasProvisioner(reloaded.get("man") as never)).toBe(false);
    expect(Object.keys(reloaded.get("win") ?? {})).not.toContain("provisionerScript");
  });

  test("a managed target takes no provisioner, and a bad script path in a file drops the fields", async () => {
    const store = new TargetStore(file);
    await store.add({ ...input, managedHost: "pve" });
    expect(await status(store.setProvisioner("nas", value))).toBe(400);

    const plain = new TargetStore(file);
    await plain.add({ ...input, id: "ext" });
    await plain.setProvisioner("ext", value);
    const json = JSON.parse(await readFile(file, "utf8")) as { targets: Record<string, Record<string, unknown>> };
    json.targets.ext = { ...json.targets.ext, provisionerScript: "relative" };
    await Bun.write(file, JSON.stringify(json));
    expect(hasProvisioner(new TargetStore(file).get("ext") as never)).toBe(false);
  });
});
