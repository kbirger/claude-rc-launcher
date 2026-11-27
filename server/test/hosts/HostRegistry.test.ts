import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostClient, HostConfig } from "../../src/hosts/client";
import { HostRegistry } from "../../src/hosts/HostRegistry";
import { certFingerprint } from "../../src/auth/hubproof";
import { ensureNodeCert } from "../../src/hosts/tls";
import { rejection, defined } from "../support";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-reg-"));
const client = (): HostClient => ({
  stream: () => {
    return Promise.reject(new Error("unused"));
  },
  call: () => Promise.resolve({ status: 200, body: {} }),
});
const PEM = (await ensureNodeCert({ dir: tmp(), names: ["localhost"] })).certPem;
const host = (id: string, over: Partial<HostConfig> = {}): HostConfig => ({
  id,
  name: id.toUpperCase(),
  url: "https://10.0.0.5:8443",
  ca: PEM,
  auth: { type: "hub_key" },
  ...over,
});
const staticHost = host("nas");
const load = (stateDir: string) =>
  HostRegistry.load({
    stateDir,
    hosts: [staticHost],
    clients: new Map([["nas", client()]]),
    makeClient: () => client(),
  });

describe("HostRegistry", () => {
  test("add persists and a new registry instance reloads it", async () => {
    const dir = tmp();
    const hostRegistry = await load(dir);
    await hostRegistry.add(host("pi", { serverName: "pi.internal" }));
    expect(hostRegistry.list().map((hostEntry) => [hostEntry.host.id, hostEntry.source])).toEqual([
      ["nas", "config"],
      ["pi", "managed"],
    ]);
    const again = await load(dir);
    const pi = defined(again.get("pi"));
    expect(pi.source).toBe("managed");
    expect(pi.host).toMatchObject({
      id: "pi",
      name: "PI",
      url: "https://10.0.0.5:8443",
      serverName: "pi.internal",
      ca: PEM,
      auth: { type: "hub_key" },
    });
    const json = JSON.parse(readFileSync(path.join(dir, "managed-hosts.json"), "utf8"));
    expect(json._comment).toContain("Do not edit by hand");
    expect(json.hosts).toEqual([{ id: "pi", name: "PI", url: "https://10.0.0.5:8443", server_name: "pi.internal" }]);
  });

  test("a corrupt pin file fails the load with the file and the host in the message", async () => {
    const dir = tmp();
    await (await load(dir)).add(host("pi"));
    const pin = path.join(dir, "pins", "pi.pem");
    writeFileSync(pin, "not a certificate");

    // like the hub: the client of a hub_key host reads the fingerprint of its pinned certificate at once
    const makeClient = (hostConfig: HostConfig): HostClient => {
      certFingerprint(hostConfig.ca);
      return client();
    };

    const entry = await HostRegistry.load({
      stateDir: dir,
      hosts: [staticHost],
      clients: new Map([["nas", client()]]),
      makeClient,
    }).catch((error) => error as Error);
    expect(entry).toBeInstanceOf(Error);
    expect((entry as Error).message).toStartWith(`cannot use ${pin} for managed host pi: `);
  });

  test("files and directories get the modes from the design", async () => {
    if (process.platform === "win32") return;
    const dir = tmp();
    const hostRegistry = await load(dir);
    await hostRegistry.add(host("pi"));
    expect(statSync(path.join(dir, "pins")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "pins", "pi.pem")).mode & 0o777).toBe(0o644);
  });

  test("add rejects local, bad ids, duplicates and config ids before touching the disk", async () => {
    const dir = tmp();
    const hostRegistry = await load(dir);

    for (const id of ["local", "../x", "a/b", "UPPER", "", "x".repeat(33)]) {
      expect(await rejection(hostRegistry.add(host(id)))).toMatchObject({ status: id === "local" ? 409 : 400 });
    }

    expect(await rejection(hostRegistry.add(host("nas")))).toMatchObject({ status: 409 });
    await hostRegistry.add(host("pi"));
    expect(await rejection(hostRegistry.add(host("pi")))).toMatchObject({ status: 409 });
    expect(existsSync(path.join(dir, "pins", "x.pem"))).toBe(false);
    expect(hostRegistry.list().map((hostEntry) => hostEntry.host.id)).toEqual(["nas", "pi"]);
  });

  test("remove deletes the json entry and the pin", async () => {
    const dir = tmp();
    const hostRegistry = await load(dir);
    await hostRegistry.add(host("pi"));
    await hostRegistry.remove("pi");
    expect(hostRegistry.get("pi")).toBeUndefined();
    expect(existsSync(path.join(dir, "pins", "pi.pem"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "managed-hosts.json"), "utf8")).hosts).toEqual([]);
  });

  test("remove of a config host is 409 and names config.toml; unknown id is 404", async () => {
    const hostRegistry = await load(tmp());
    expect(await rejection(hostRegistry.remove("nas"))).toMatchObject({
      status: 409,
      message: expect.stringContaining("config.toml"),
    });
    expect(await rejection(hostRegistry.remove("nope"))).toMatchObject({ status: 404 });
  });

  test("ten concurrent adds of one id: exactly one succeeds", async () => {
    const hostRegistry = await load(tmp());
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => hostRegistry.add(host("pi"))));
    expect(results.filter((promiseSettledResult) => promiseSettledResult.status === "fulfilled")).toHaveLength(1);
    expect(hostRegistry.list().filter((hostEntry) => hostEntry.host.id === "pi")).toHaveLength(1);
  });

  test("a corrupt json file makes load throw a message naming the file", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "managed-hosts.json"), "{nope");
    expect((await rejection(load(dir))).message).toContain("managed-hosts.json");
  });

  test("a missing pin file makes load throw", async () => {
    const dir = tmp();
    const hostRegistry = await load(dir);
    await hostRegistry.add(host("pi"));
    rmSync(path.join(dir, "pins", "pi.pem"));
    expect((await rejection(load(dir))).message).toContain("pi.pem");
  });

  test("a managed id that collides with a config id makes load throw", async () => {
    const dir = tmp();
    const hostRegistry = await HostRegistry.load({
      stateDir: dir,
      hosts: [],
      clients: new Map(),
      makeClient: () => client(),
    });
    await hostRegistry.add(host("nas"));
    expect((await rejection(load(dir))).message).toContain("nas");
  });

  test("a memory registry lists static hosts and add throws 501", async () => {
    const hostRegistry = HostRegistry.memory([staticHost], new Map([["nas", client()]]));
    expect(hostRegistry.list().map((hostEntry) => hostEntry.host.id)).toEqual(["nas"]);
    expect(await rejection(hostRegistry.add(host("pi")))).toMatchObject({ status: 501 });
  });
});

describe("rename", () => {
  test("changes the name of a managed host, keeps the id and saves it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rc-ren-"));
    const makeClient = (_h: HostConfig): HostClient => ({
      stream: () => {
        return Promise.reject(new Error("unused"));
      },
      call: () => Promise.resolve({ status: 200, body: {} }),
    });
    const reg = await HostRegistry.load({ stateDir: dir, hosts: [], clients: new Map(), makeClient });
    await reg.add({ id: "win", name: "win", url: "https://10.0.0.5:8443", ca: "x", auth: { type: "hub_key" } });
    await reg.rename("win", "KIRSTATION4");
    expect(reg.get("win")?.host.name).toBe("KIRSTATION4");
    const again = await HostRegistry.load({ stateDir: dir, hosts: [], clients: new Map(), makeClient });
    expect(again.get("win")?.host.name).toBe("KIRSTATION4");
    expect((await rejection(reg.rename("nope", "x"))).message).toContain("unknown host");
  });
});
