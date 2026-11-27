import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../../../src/app";
import type { Config, HostConfig } from "../../../src/config/parse";
import type { HostClient } from "../../../src/hosts/client";
import { HostRegistry } from "../../../src/hosts/HostRegistry";
import { SessionsStore } from "../../../src/sessions/SessionsStore";

const cfgHost = (id: string): HostConfig => ({ id, name: `name-${id}`, url: "https://x:1", ca: "PEM", auth: { type: "secret", secret: "s" } });
const row = (id: string) => ({ id, root: "/r", startedAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:00.000Z", instance: { id: "0123456789ab", name: "inst", path: "/p", state: "active" } });
const list = (...ids: string[]) => ({ scannedAt: "2026-01-02T00:00:00.000Z", available: true, sessions: ids.map(row) });

const user = { sub: "u1", name: "Ann", username: "kir", role: "admin" };
const userAuth = { middleware: (async (c, next) => (c.set("user" as never, user as never), next())) as MiddlewareHandler };
const cliAuth = (async (c, next) => (c.set("user" as never, user as never), next())) as MiddlewareHandler;
const cli = { issuer: "https://i", clientId: "c", auth: cliAuth, makeClient: (() => undefined) as any, enrollment: { hubKeys: [] } };
const cfg = { name: "the-hub", hosts: [], roots: [], publicUrl: "https://rc.example.com" } as unknown as Config;
const noPresence = { list: () => [], onChange: () => () => {} };

/** A registry whose clients fail the test if anything calls them. */
function registryThatMustNotBeCalled(ids: string[]) {
  const calls: string[] = [];
  const client = { call: async (_m: string, p: string) => { calls.push(p); throw new Error("a node was called"); }, stream: async () => { throw new Error("a node was streamed"); } } as unknown as HostClient;
  return { calls, registry: HostRegistry.memory(ids.map(cfgHost), new Map(ids.map((id) => [id, client]))) };
}

describe("hub all-sessions route", () => {
  test("answers the store answer and calls no node", async () => {
    const { calls, registry } = registryThatMustNotBeCalled(["nas"]);
    const store = new SessionsStore({ localName: "the-hub", registry, presence: noPresence });
    store.set("local", list("l1"));
    store.set("nas", list("r1", "r2"));
    const app = createApp({ cfg, instances: { list: async () => [] } as any, userAuth, hosts: registry, sessionsStore: store, sessionIndex: { subscribe: () => () => {}, trigger: () => {} } as any });
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(store.answer() as any);
    expect(calls).toEqual([]);
    const body = store.answer();
    expect(body.sessions.map((s) => `${s.host.id}:${s.id}`)).toEqual(["local:l1", "nas:r1", "nas:r2"]);
  });

  test("the CLI route /cli/api/sessions answers the same", async () => {
    const { calls, registry } = registryThatMustNotBeCalled(["nas"]);
    const store = new SessionsStore({ localName: "the-hub", registry, presence: noPresence });
    store.set("nas", list("r1"));
    const app = createApp({ cfg, instances: { list: async () => [] } as any, userAuth, hosts: registry, sessionsStore: store, sessionIndex: { subscribe: () => () => {}, trigger: () => {} } as any, cli });
    const browser = await (await app.request("/api/sessions")).json();
    const res = await app.request("/cli/api/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(browser);
    expect(browser).toEqual(store.answer() as any);
    expect(calls).toEqual([]);
  });

  test("createApp with no sessionIndex builds one and feeds local into the store", async () => {
    const registry = HostRegistry.memory([], new Map());
    const store = new SessionsStore({ localName: "the-hub", registry, presence: noPresence });
    // No claudeHome: the index emits one unavailable list as soon as it starts, with no timer and no scan.
    createApp({ cfg, instances: { list: async () => [] } as any, userAuth, hosts: registry, sessionsStore: store });
    expect(store.answer().hosts).toEqual([{ id: "local", name: "the-hub", status: "unavailable" }]);
    expect(store.available("local")).toBe(false);
  });

  test("createApp with no store and no presence answers the local list from its own store", async () => {
    const app = createApp({ cfg, instances: { list: async () => [] } as any, userAuth });
    const body = (await (await app.request("/api/sessions")).json()) as any;
    expect(body).toEqual({ sessions: [], hosts: [{ id: "local", name: "the-hub", status: "unavailable" }] });
  });
});
