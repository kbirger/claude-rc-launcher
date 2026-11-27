import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostClient, HostConfig } from "../../src/hosts/client";
import { HostRegistry } from "../../src/hosts/HostRegistry";
import { ensureNodeCert } from "../../src/hosts/tls";
import { rejection } from "../support";

const client = (): HostClient => ({
  stream: () => {
    return Promise.reject(new Error("unused"));
  },
  call: () => Promise.resolve({ status: 200, body: {} }),
});
const PEM = (await ensureNodeCert({ dir: mkdtempSync(path.join(os.tmpdir(), "rc-regev-")), names: ["localhost"] }))
  .certPem;
const host = (id: string): HostConfig => ({
  id,
  name: id,
  url: "https://10.0.0.5:8443",
  ca: PEM,
  auth: { type: "hub_key" },
});
const make = () =>
  HostRegistry.load({
    stateDir: mkdtempSync(path.join(os.tmpdir(), "rc-regev-")),
    hosts: [],
    clients: new Map(),
    makeClient: () => client(),
  });

describe("HostRegistry.onChange", () => {
  test("add and remove notify, and the entry is already visible", async () => {
    const hostRegistry = await make();
    const seen: string[] = [];
    hostRegistry.onChange((event) =>
      seen.push(`${event.type}:${event.id}:${hostRegistry.get(event.id) ? "present" : "gone"}`),
    );
    await hostRegistry.add(host("pi"));
    await hostRegistry.remove("pi");
    expect(seen).toEqual(["added:pi:present", "removed:pi:gone"]);
  });

  test("rename notifies, and the entry already has the new name", async () => {
    const r = await make();
    await r.add(host("pi"));
    const seen: string[] = [];
    r.onChange((e) => seen.push(`${e.type}:${e.id}:${r.get(e.id)?.host.name}`));
    await r.rename("pi", "Kitchen Pi");
    expect(seen).toEqual(["renamed:pi:Kitchen Pi"]);
  });

  test("a failed add does not notify, an unsubscribed listener gets nothing, a throwing listener does not break add", async () => {
    const hostRegistry = await make();
    const seen: string[] = [];
    hostRegistry.onChange(() => {
      throw new Error("bad listener");
    });
    const off = hostRegistry.onChange((event) => seen.push(event.type));
    await hostRegistry.add(host("pi"));
    expect(await rejection(hostRegistry.add(host("pi")))).toBeInstanceOf(Error);
    expect(seen).toEqual(["added"]);
    off();
    await hostRegistry.remove("pi");
    expect(seen).toEqual(["added"]);
  });
});
