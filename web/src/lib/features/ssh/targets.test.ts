import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import type { Grant, Target } from "./api";
import { createTargetListModel, hasProvisioner, pendingMaintenance, stuckRetire, stuckText } from "./targets.svelte";

const target = (extra: Partial<Target> = {}): Target => ({
  id: "nas",
  address: "10.0.0.5",
  port: 22,
  account: "root",
  systemType: "linux",
  nodes: ["node1"],
  state: "ready",
  keyFingerprint: "SHA256:abc",
  ...extra,
});
const grant = (extra: Partial<Grant> = {}): Grant => ({
  id: "g1",
  nodeId: "local",
  instanceId: "maintenance",
  targetId: "nas",
  minutes: 1,
  test: false,
  state: "pending",
  requestedAt: 1,
  maintenance: { action: "uninstall", fromNodes: [], fromSources: [] },
  ...extra,
});
const PROV = target({ provisionerFingerprint: "SHA256:p", provisionerSource: "10.0.0.9" });

describe("target rules", () => {
  test("only an external target with a provisioner fingerprint has a provisioner", () => {
    expect(hasProvisioner(PROV)).toBe(true);
    expect(hasProvisioner(target())).toBe(false);
    expect(hasProvisioner({ ...PROV, managedHost: "node1" })).toBe(false);
  });

  test("a pending or active maintenance request is open, an ended one or a session is not", () => {
    expect(pendingMaintenance([grant()], PROV)?.id).toBe("g1");
    expect(pendingMaintenance([grant({ state: "active" })], PROV)?.id).toBe("g1");
    expect(pendingMaintenance([grant({ state: "ended" })], PROV)).toBeUndefined();
    expect(pendingMaintenance([grant({ maintenance: undefined })], PROV)).toBeUndefined();
    expect(pendingMaintenance([grant({ targetId: "web" })], PROV)).toBeUndefined();
  });

  test("a stuck retire is the newest grant, ended, of a disabled target with a provisioner", () => {
    const disabled = { ...PROV, state: "disabled" as const };
    const ended = grant({ state: "ended", endReason: "denied", requestedAt: 2 });
    expect(stuckRetire([ended], disabled)?.id).toBe("g1");
    expect(stuckRetire([ended], PROV)).toBeUndefined();
    expect(
      stuckRetire([ended, grant({ id: "s", maintenance: undefined, state: "ended", requestedAt: 3 })], disabled),
    ).toBeUndefined();
    expect(stuckRetire([ended, grant({ id: "p", requestedAt: 0 })], disabled)).toBeUndefined();
    expect(stuckText(ended)).toBe(
      "The request to retire this target was denied. Nothing was removed from the machine. The target is disabled and keeps its keys.",
    );
    expect(stuckText(grant({ endReason: "node-lost" }))).toMatch(/^The request to retire this target ended\./);
  });
});

let calls: { method: string; url: string }[];
let replies: Record<string, { status: number; body: unknown }>;
let local: unknown;
beforeEach(() => {
  calls = [];
  replies = {};
  local = { host: "local", enabled: true, sourceAddress: "10.0.0.9" };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    calls.push({ method, url: path });
    const reply = replies[`${method} ${path}`];
    if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status });
    const body = path === "/api/ssh/status" ? { setUp: true, nodes: local ? [local] : [] } : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient();
  const { value: model, dispose } = inRoot(() => createTargetListModel({ client }));
  flushSync();
  return { model, dispose };
}

describe("target list model", () => {
  test("a changed or switched-off source of local makes a provisioner target stale", async () => {
    const list = mount();
    await vi.waitFor(() => expect(list.model.nodes).toHaveLength(1));
    expect(list.model.staleSource(PROV)).toBe(false);
    expect(list.model.staleSource({ ...PROV, provisionerSource: "10.0.0.1" })).toBe(true);
    expect(list.model.staleSource(target())).toBe(false);
    expect(list.model.localOff).toBe(false);
    list.dispose();
  });

  test("a retire asks first, and a refusal of the maintenance path offers the retire without cleanup", async () => {
    replies["DELETE /api/ssh/targets/nas"] = { status: 409, body: { error: "this target has no provisioner" } };
    const list = mount();
    list.model.askRetire(PROV);
    expect(list.model.ask?.title).toBe("Retire nas?");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    list.model.ask!.run();
    await vi.waitFor(() => expect(list.model.refusedOf(PROV)).toBe("this target has no provisioner"));
    expect(list.model.problem).toBe("");
    list.dispose();
  });

  test("the same refusal for a target without a provisioner shows as an error", async () => {
    replies["DELETE /api/ssh/targets/nas"] = { status: 409, body: { error: "this target has no provisioner" } };
    const list = mount();
    list.model.askRetire(target());
    list.model.ask!.run();
    await vi.waitFor(() => expect(list.model.problem).toBe("this target has no provisioner"));
    expect(list.model.refusedOf(target())).toBeUndefined();
    list.dispose();
  });

  test("a retire without cleanup sends cleanup=none, and a maintenance answer says it waits", async () => {
    replies["DELETE /api/ssh/targets/nas?cleanup=none"] = {
      status: 200,
      body: { maintenance: { action: "uninstall" } },
    };
    const list = mount();
    list.model.askRetireWithoutCleanup(PROV);
    list.model.ask!.run();
    await vi.waitFor(() => expect(list.model.notice).toMatch(/^The request to retire for nas waits for your approval/));
    list.model.dismissNotice();
    expect(list.model.notice).toBe("");
    list.dispose();
  });

  test("a reinstall says that the request waits, and a failed state change shows its error", async () => {
    replies["PATCH /api/ssh/targets/nas"] = { status: 500, body: { error: "down" } };
    const list = mount();
    await list.model.reinstall(PROV);
    expect(list.model.notice).toMatch(/^The request to put the key line back for nas/);
    await list.model.setState(PROV, "disabled");
    expect(list.model.problem).toBe("down");
    expect(list.model.notice).toBe("");
    list.dispose();
  });

  test("edit opens and closes the node editor of one target", () => {
    const list = mount();
    list.model.edit("nas");
    expect(list.model.editing).toBe("nas");
    list.model.edit(null);
    expect(list.model.editing).toBeNull();
    list.dispose();
  });
});
