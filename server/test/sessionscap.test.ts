import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createNodeApp } from "../src/app";
import type { Config } from "../src/config/parse";
import { createHostClient, type HostConfig } from "../src/hostclient";
import type { HostEntry, HostRegistry } from "../src/hostregistry";
import { createNodeWatchers, type Presence } from "../src/nodewatcher";
import type { SessionsPayload } from "../src/sessionindex";
import { UpdateLog } from "../src/updatelog";
import { NodeEvents } from "../src/updateevents";

// A node with a very large session list: the whole path from the index to the hub watcher, through the real SSE reader.

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const ID = "0123456789ab";
const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== "Bearer ok") return c.json({ error: "unauthorized" }, 401);
  c.set("caller" as never, "hub" as never);
  await next();
};
const cfg = { mode: "node", name: "pi", roots: ["/srv"] } as unknown as Config;
const ROWS = 5_000;
const summaries = Array.from({ length: ROWS }, (_, i) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  root: "/srv/p",
  name: `a session with a long enough name to look real, number ${i}`,
  branch: "feat/some-branch",
  startedAt: new Date(T0).toISOString(),
  lastActiveAt: new Date(T0 + i * 1_000).toISOString(),
}));

describe("a node with a session list over the SSE cap", () => {
  test("the snapshot fits, the watcher stays online and gets the newest rows with truncated", async () => {
    const instances: any = {
      list: async () => [{ id: ID, path: "/srv/p", name: "p", state: "active", startedAt: null }],
      claudeHome: async () => ({ path: "/srv/p", home: "/home/p" }),
    };
    const catalog: any = { instance: () => ({ list: async () => summaries }), readLive: async () => new Map() };
    const events = new NodeEvents();
    const source = { start: () => {}, stop: () => {}, setActive: () => {} };
    const app = createNodeApp({ cfg, instances, auth, events, sessionSource: source, sessions: catalog });
    for (let i = 0; i < 100 && !events.latestSessions(); i++) await new Promise<void>((r) => setImmediate(r));
    expect(events.latestSessions()).not.toBeNull();

    const host: HostConfig = { id: "pi", name: "pi", url: "https://pi.test:8443", ca: "", auth: { type: "hub_key" } };
    const client = createHostClient(host, async () => "Bearer ok", {
      fetch: (async (url: URL, init: RequestInit) => app.request(url.pathname, { headers: init.headers, ...(init.signal ? { signal: init.signal } : {}) })) as unknown as typeof fetch,
    });
    const entry: HostEntry = { host, client, source: "managed" };
    const registry = { list: () => [entry], get: (id: string) => (id === "pi" ? entry : undefined), onChange: () => () => {} };
    let first!: (p: Presence) => void;
    const firstPresence = new Promise<Presence>((r) => (first = r));
    let gotSessions!: (e: SessionsPayload) => void;
    const sessions = new Promise<SessionsPayload>((r) => (gotSessions = r));
    const w = createNodeWatchers({
      registry: registry as unknown as HostRegistry,
      log: new UpdateLog(),
      onPresence: (p) => first(p),
      onStep: () => {},
      onSessions: (_h, e) => gotSessions(e),
      // No real time passes: the silence timer and the retry waits never end.
      sleep: () => new Promise<void>(() => {}),
      random: () => 0,
    });
    try {
      const p = await firstPresence;
      expect(p.status).toBe("online");
      const got = await sessions;
      expect(got.truncated).toBe(true);
      expect(got.sessions.length).toBeGreaterThan(1_000);
      expect(got.sessions.length).toBeLessThan(ROWS);
      expect(got.sessions.map((s) => s.id)).toContain(summaries[ROWS - 1]!.id);
      expect(got.sessions.map((s) => s.id)).not.toContain(summaries[0]!.id);
      expect(w.presence().map((x) => x.status)).toEqual(["online"]);
    } finally {
      w.stop();
    }
  });
});
