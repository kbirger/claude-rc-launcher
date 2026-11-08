import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostRegistry } from "../src/hostregistry";
import type { HostClient, HostConfig } from "../src/hostclient";
import { ensureNodeCert } from "../src/tls";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-reg-"));
const client = (): HostClient => ({ call: async () => ({ status: 200, body: {} }) });
const PEM = (await ensureNodeCert({ dir: tmp(), names: ["localhost"] })).certPem;
const host = (id: string, over: Partial<HostConfig> = {}): HostConfig => ({
  id, name: id.toUpperCase(), url: "https://10.0.0.5:8443", ca: PEM, auth: { type: "hub_key" }, ...over,
});
const staticHost = host("nas");
const load = (stateDir: string) =>
  HostRegistry.load({ stateDir, hosts: [staticHost], clients: new Map([["nas", client()]]), makeClient: () => client() });

describe("HostRegistry", () => {
  test("add persists and a new registry instance reloads it", async () => {
    const dir = tmp();
    const r = await load(dir);
    await r.add(host("pi", { serverName: "pi.internal" }));
    expect(r.list().map((e) => [e.host.id, e.source])).toEqual([["nas", "config"], ["pi", "managed"]]);
    const again = await load(dir);
    const pi = again.get("pi")!;
    expect(pi.source).toBe("managed");
    expect(pi.host).toMatchObject({ id: "pi", name: "PI", url: "https://10.0.0.5:8443", serverName: "pi.internal", ca: PEM, auth: { type: "hub_key" } });
    const json = JSON.parse(readFileSync(path.join(dir, "managed-hosts.json"), "utf8"));
    expect(json._comment).toContain("Do not edit by hand");
    expect(json.hosts).toEqual([{ id: "pi", name: "PI", url: "https://10.0.0.5:8443", server_name: "pi.internal" }]);
  });

  test("files and directories get the modes from the design", async () => {
    if (process.platform === "win32") return;
    const dir = tmp();
    const r = await load(dir);
    await r.add(host("pi"));
    expect(statSync(path.join(dir, "pins")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "pins", "pi.pem")).mode & 0o777).toBe(0o644);
  });

  test("add rejects local, bad ids, duplicates and config ids before touching the disk", async () => {
    const dir = tmp();
    const r = await load(dir);
    for (const id of ["local", "../x", "a/b", "UPPER", "", "x".repeat(33)]) {
      await expect(r.add(host(id))).rejects.toMatchObject({ status: id === "local" ? 409 : 400 });
    }
    await expect(r.add(host("nas"))).rejects.toMatchObject({ status: 409 });
    await r.add(host("pi"));
    await expect(r.add(host("pi"))).rejects.toMatchObject({ status: 409 });
    expect(existsSync(path.join(dir, "pins", "x.pem"))).toBe(false);
    expect(r.list().map((e) => e.host.id)).toEqual(["nas", "pi"]);
  });

  test("remove deletes the json entry and the pin", async () => {
    const dir = tmp();
    const r = await load(dir);
    await r.add(host("pi"));
    await r.remove("pi");
    expect(r.get("pi")).toBeUndefined();
    expect(existsSync(path.join(dir, "pins", "pi.pem"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "managed-hosts.json"), "utf8")).hosts).toEqual([]);
  });

  test("remove of a config host is 409 and names config.toml; unknown id is 404", async () => {
    const r = await load(tmp());
    await expect(r.remove("nas")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("config.toml") });
    await expect(r.remove("nope")).rejects.toMatchObject({ status: 404 });
  });

  test("ten concurrent adds of one id: exactly one succeeds", async () => {
    const r = await load(tmp());
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => r.add(host("pi"))));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.list().filter((e) => e.host.id === "pi")).toHaveLength(1);
  });

  test("a corrupt json file makes load throw a message naming the file", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "managed-hosts.json"), "{nope");
    await expect(load(dir)).rejects.toThrow("managed-hosts.json");
  });

  test("a missing pin file makes load throw", async () => {
    const dir = tmp();
    const r = await load(dir);
    await r.add(host("pi"));
    rmSync(path.join(dir, "pins", "pi.pem"));
    await expect(load(dir)).rejects.toThrow("pi.pem");
  });

  test("a managed id that collides with a config id makes load throw", async () => {
    const dir = tmp();
    const r = await HostRegistry.load({ stateDir: dir, hosts: [], clients: new Map(), makeClient: () => client() });
    await r.add(host("nas"));
    await expect(load(dir)).rejects.toThrow("nas");
  });

  test("a memory registry lists static hosts and add throws 501", async () => {
    const r = HostRegistry.memory([staticHost], new Map([["nas", client()]]));
    expect(r.list().map((e) => e.host.id)).toEqual(["nas"]);
    await expect(r.add(host("pi"))).rejects.toMatchObject({ status: 501 });
  });
});
