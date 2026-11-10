import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostRegistry } from "../src/hostregistry";
import type { HostClient, HostConfig } from "../src/hostclient";
import { ensureNodeCert } from "../src/tls";

const client = (): HostClient => ({ stream: async () => { throw new Error("unused"); }, call: async () => ({ status: 200, body: {} }) });
const PEM = (await ensureNodeCert({ dir: mkdtempSync(path.join(os.tmpdir(), "rc-regev-")), names: ["localhost"] })).certPem;
const host = (id: string): HostConfig => ({ id, name: id, url: "https://10.0.0.5:8443", ca: PEM, auth: { type: "hub_key" } });
const make = () =>
  HostRegistry.load({ stateDir: mkdtempSync(path.join(os.tmpdir(), "rc-regev-")), hosts: [], clients: new Map(), makeClient: () => client() });

describe("HostRegistry.onChange", () => {
  test("add and remove notify, and the entry is already visible", async () => {
    const r = await make();
    const seen: string[] = [];
    r.onChange((e) => seen.push(`${e.type}:${e.id}:${r.get(e.id) ? "present" : "gone"}`));
    await r.add(host("pi"));
    await r.remove("pi");
    expect(seen).toEqual(["added:pi:present", "removed:pi:gone"]);
  });

  test("a failed add does not notify, an unsubscribed listener gets nothing, a throwing listener does not break add", async () => {
    const r = await make();
    const seen: string[] = [];
    r.onChange(() => {
      throw new Error("bad listener");
    });
    const off = r.onChange((e) => seen.push(e.type));
    await r.add(host("pi"));
    await expect(r.add(host("pi"))).rejects.toThrow();
    expect(seen).toEqual(["added"]);
    off();
    await r.remove("pi");
    expect(seen).toEqual(["added"]);
  });
});
