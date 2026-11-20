import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createNodeApp } from "../src/app";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import { NodeEvents } from "../src/updateevents";
import { VERSION } from "../src/version";

const cfg = { mode: "node", name: "pi", roots: ["/srv"] } as unknown as Config;
const ID = "0123456789ab";
const inst = { id: ID, path: "/srv/p", name: "n", state: "active", startedAt: null };
const instances: any = {
  list: async () => [inst],
  start: async () => inst,
  stop: async () => {},
  logs: async () => "log",
  users: async () => ({ selectable: false, default: "svc", users: [{ name: "svc" }] }),
};
const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== "Bearer ok") return c.json({ error: "unauthorized" }, 401);
  c.set("caller" as never, "secret" as never);
  await next();
};
const app = () => createNodeApp({ cfg, instances, auth });
const ok = { authorization: "Bearer ok" };
const json = { ...ok, "content-type": "application/json" };

let logged: string[] = [];
const realLog = console.log;
beforeEach(() => {
  logged = [];
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
});
afterEach(() => {
  console.log = realLog;
});

describe("node app", () => {
  test("/healthz is open", async () => {
    expect((await app().request("/healthz")).status).toBe(200);
  });
  test("/api/node carries the client versions of the machine", async () => {
    const clients = [{ path: "/usr/local/bin/claude-rc", version: "0.8.2" }, { path: "/root/.local/bin/claude-rc" }];
    const a = createNodeApp({ cfg, instances, auth, clientVersions: async () => clients });
    expect((await (await a.request("/api/node", { headers: ok })).json()).clients).toEqual(clients);
  });
  test("/api/update resets the client versions after a client update and not after up-to-date", async () => {
    const run = (report: unknown) => async () => report as any;
    const call = async (report: unknown) => {
      let resets = 0;
      const clientVersions = Object.assign(async () => [], { reset: () => void resets++ });
      const a = createNodeApp({ cfg, instances, auth, clientVersions, update: { run: run(report) } });
      await a.request("/api/update", { method: "POST", headers: json, body: "{}" });
      return resets;
    };
    expect(await call({ status: "clients-only", from: "1", clients: [] })).toBe(1);
    expect(await call({ status: "restarting", from: "1", clients: [] })).toBe(1);
    expect(await call({ status: "failed", from: "1", clients: [{ path: "/p", status: "updated" }] })).toBe(1);
    expect(await call({ status: "up-to-date", from: "1", clients: [{ path: "/p", status: "up-to-date" }] })).toBe(0);
  });
  test("a pending client lookup does not block other requests", async () => {
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = createNodeApp({ cfg, instances, auth, clientVersions: async () => (starts++, await gate, [{ path: "/p", version: "1.0.0" }]) });
    const n1 = a.request("/api/node", { headers: ok });
    const n2 = a.request("/api/node", { headers: ok });
    expect((await a.request("/api/instances", { headers: ok })).status).toBe(200);
    release();
    expect((await (await n1).json()).clients).toEqual([{ path: "/p", version: "1.0.0" }]);
    expect((await (await n2).json()).clients).toEqual([{ path: "/p", version: "1.0.0" }]);
    expect(starts).toBe(2); // sharing one lookup is createClientVersions' job (see serviceupdate.test.ts)
  });
  test("a throwing client lookup gives 200 and no clients field", async () => {
    const a = createNodeApp({ cfg, instances, auth, clientVersions: async () => { throw new Error("boom"); } });
    const r = await a.request("/api/node", { headers: ok });
    const body = await r.json();
    expect([r.status, "clients" in body]).toEqual([200, false]);
  });
  test("/api routes need auth", async () => {
    for (const p of ["/api/node", "/api/instances", "/api/fs"]) expect((await app().request(p)).status).toBe(401);
  });
  test("/api/node and instance routes work with auth", async () => {
    const a = app();
    expect(await (await a.request("/api/node", { headers: ok })).json()).toEqual({ ok: true, name: "pi", version: VERSION, platform: process.platform, clone: false, clients: [] });
    expect(await (await a.request("/api/instances", { headers: ok })).json()).toEqual([inst]);
    expect((await a.request("/api/instances", { method: "POST", headers: json, body: JSON.stringify({ path: "/srv/p" }) })).status).toBe(201);
    expect((await a.request(`/api/instances/${ID}`, { method: "DELETE", headers: json })).status).toBe(204);
    expect(await (await a.request(`/api/instances/${ID}/logs`, { headers: ok })).json()).toEqual({ log: "log" });
  });
  test("/api/node reports the service definition when the node has one, and nothing when it has none", async () => {
    const withDef = createNodeApp({ cfg, instances, auth, definition: () => ({ installed: 1, required: 2 }) });
    expect(((await (await withDef.request("/api/node", { headers: ok })).json()) as any).definition).toEqual({ installed: 1, required: 2 });
    const none = createNodeApp({ cfg, instances, auth, definition: () => undefined });
    expect("definition" in ((await (await none.request("/api/node", { headers: ok })).json()) as any)).toBe(false);
  });
  test("/api/users needs auth and returns the info", async () => {
    const a = app();
    expect((await a.request("/api/users")).status).toBe(401);
    expect(await (await a.request("/api/users", { headers: ok })).json()).toEqual({ selectable: false, default: "svc", users: [{ name: "svc" }] });
  });
  test("no browser surface: /auth/login and / are 404", async () => {
    const a = app();
    expect((await a.request("/auth/login", { headers: ok })).status).toBe(404);
    expect((await a.request("/", { headers: ok })).status).toBe(404);
  });
  test("state-changing requests need application/json (415); Origin is ignored", async () => {
    const a = app();
    const noct = await a.request("/api/instances", { method: "POST", headers: ok, body: "{}" });
    expect(noct.status).toBe(415);
    const withOrigin = await a.request("/api/instances", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ path: "/srv/p" }) });
    expect(withOrigin.status).toBe(201);
  });
  test("a POST emits an audit line with caller, method, path and status", async () => {
    await app().request("/api/instances", { method: "POST", headers: json, body: JSON.stringify({ path: "/srv/p" }) });
    expect(logged.some((l) => l === "audit caller=secret POST /api/instances 201")).toBe(true);
  });
  test("GETs are not audited", async () => {
    await app().request("/api/instances", { headers: ok });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual([]);
  });

  describe("clone routes", () => {
    const code = "WDJB-MJHT";
    const cloner: any = {
      cloneStart: async () => ({ id: "c".repeat(32), path: "/srv/x" }),
      cloneStatus: async (id: string) => {
        if (id === "b".repeat(32)) throw new HttpError(404, "unknown clone");
        return { state: "running" };
      },
      repos: async () => ({ groups: [] }),
      loginStart: async () => ({ id: "a".repeat(32), code, url: "https://github.com/login/device" }),
      loginStatus: async () => ({ state: "pending" }),
    };
    const capp = () => createNodeApp({ cfg, instances, auth, cloner });
    test("need the bearer proof", async () => {
      const a = capp();
      expect((await a.request("/api/clone", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await a.request("/api/github/repos")).status).toBe(401);
      expect((await a.request(`/api/clone/${"a".repeat(32)}`)).status).toBe(401);
      expect((await a.request(`/api/github/login/${"a".repeat(32)}`)).status).toBe(401);
    });
    test("work with auth, need JSON, and /node says clone: true", async () => {
      const a = capp();
      expect((await (await a.request("/api/node", { headers: ok })).json()).clone).toBe(true);
      const c = await a.request("/api/clone", { method: "POST", headers: json, body: JSON.stringify({ repo: "o/x", parent: "/srv" }) });
      expect([c.status, await c.json()]).toEqual([202, { id: "c".repeat(32), path: "/srv/x" }]);
      expect((await (await a.request(`/api/clone/${"c".repeat(32)}`, { headers: ok })).json())).toEqual({ state: "running" });
      const bad = await a.request("/api/clone/xyz", { headers: ok });
      expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid clone id" }]);
      expect((await a.request(`/api/clone/${"b".repeat(32)}`, { headers: ok })).status).toBe(404);
      expect((await a.request("/api/clone", { method: "POST", headers: { ...ok, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await a.request("/api/github/repos", { headers: ok })).status).toBe(200);
      expect((await (await a.request(`/api/github/login/${"a".repeat(32)}`, { headers: ok })).json())).toEqual({ state: "pending" });
    });
    test("each write is audited once and the audit line holds no login code", async () => {
      const a = capp();
      const r = await a.request("/api/github/login", { method: "POST", headers: json, body: "{}" });
      expect(r.status).toBe(202);
      expect((await r.json()).code).toBe(code);
      await a.request("/api/clone", { method: "POST", headers: json, body: JSON.stringify({ repo: "o/x", parent: "/srv" }) });
      await a.request("/api/github/repos", { headers: ok });
      expect(logged).toEqual([
        "audit caller=secret POST /api/github/login 202",
        "audit caller=secret POST /api/clone 202",
      ]);
      expect(logged.join("\n")).not.toContain(code);
    });
    test("without a cloner the routes are 404", async () => {
      const a = app();
      expect((await a.request("/api/github/repos", { headers: ok })).status).toBe(404);
      expect((await a.request("/api/clone", { method: "POST", headers: json, body: "{}" })).status).toBe(404);
    });
  });
});

describe("node events route", () => {
  const mk = (events?: NodeEvents, keepaliveMs?: number) => createNodeApp({ cfg, instances, auth, ...(events ? { events } : {}), ...(keepaliveMs ? { keepaliveMs } : {}) });
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, re: RegExp) => {
    const dec = new TextDecoder();
    let text = "";
    while (!re.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    return text;
  };

  test("needs authorization", async () => {
    expect((await mk(new NodeEvents()).request("/api/events")).status).toBe(401);
  });

  test("is absent without events", async () => {
    expect((await mk().request("/api/events", { headers: ok })).status).toBe(404);
  });

  test("the first event is a snapshot with the version and no update", async () => {
    const r = await mk(new NodeEvents()).request("/api/events", { headers: ok });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("transfer-encoding")).toBeNull();
    expect(r.headers.get("connection")).toBeNull();
    const reader = r.body!.getReader();
    const text = await readUntil(reader, /\n\n/);
    expect(text.startsWith("event: snapshot\ndata: ")).toBe(true);
    expect(JSON.parse(/data: (.*)/.exec(text)![1]!)).toMatchObject({ version: VERSION, update: null });
    await reader.cancel();
  });

  test("a connection in the middle of an update gets the step, then the kept lines", async () => {
    const ev = new NodeEvents();
    ev.emit({ type: "step", step: "downloading", to: "9.9.9" });
    ev.emit({ type: "log", line: "one", at: "t1" });
    ev.emit({ type: "log", line: "two", at: "t2" });
    const r = await mk(ev).request("/api/events", { headers: ok });
    const reader = r.body!.getReader();
    const text = await readUntil(reader, /"two"[^]*\n\n/);
    const events = text.trim().split("\n\n").map((b) => ({ event: /event: (.*)/.exec(b)![1], data: JSON.parse(/data: (.*)/.exec(b)![1]!) }));
    expect(events[0]!.event).toBe("snapshot");
    expect(events[0]!.data.version).toBe(VERSION);
    expect(events[0]!.data.update).toMatchObject({ step: "downloading", to: "9.9.9" });
    expect(events.slice(1)).toEqual([
      { event: "log", data: { line: "one", at: "t1" } },
      { event: "log", data: { line: "two", at: "t2" } },
    ]);
    await reader.cancel();
  });

  test("a step and a log reach the connection", async () => {
    const ev = new NodeEvents();
    const r = await mk(ev).request("/api/events", { headers: ok });
    const reader = r.body!.getReader();
    await readUntil(reader, /\n\n/);
    ev.emit({ type: "step", step: "downloading", to: "1.2.3" });
    expect(await readUntil(reader, /\n\n/)).toBe(`event: step\ndata: ${JSON.stringify({ step: "downloading", to: "1.2.3" })}\n\n`);
    ev.emit({ type: "log", line: "hello", at: "t" });
    expect(await readUntil(reader, /\n\n/)).toBe(`event: log\ndata: ${JSON.stringify({ line: "hello", at: "t" })}\n\n`);
    await reader.cancel();
  });

  test("a keepalive comment arrives on the interval", async () => {
    const r = await mk(new NodeEvents(), 20).request("/api/events", { headers: ok });
    const reader = r.body!.getReader();
    expect(await readUntil(reader, /: keepalive\n\n/)).toContain(": keepalive\n\n");
    await reader.cancel();
  });

  test("the ninth connection gets 429, the first eight keep working, and a closed one frees its slot", async () => {
    const ev = new NodeEvents();
    const a = mk(ev);
    const open: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await a.request("/api/events", { headers: ok });
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      await readUntil(reader, /\n\n/);
      open.push(reader);
    }
    const ninth = await a.request("/api/events", { headers: ok });
    expect(ninth.status).toBe(429);
    ev.emit({ type: "log", line: "x", at: "t" });
    for (const reader of open) expect(await readUntil(reader, /\n\n/)).toContain("event: log");
    await open[0]!.cancel();
    let again: Response | undefined;
    for (let i = 0; i < 50; i++) {
      again = await a.request("/api/events", { headers: ok });
      if (again.status === 200) break;
      await Bun.sleep(10);
    }
    expect(again!.status).toBe(200);
    await again!.body!.cancel();
    for (const reader of open.slice(1)) await reader.cancel();
  });
});

describe("node sessions stream and heartbeat", () => {
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, re: RegExp) => {
    const dec = new TextDecoder();
    let text = "";
    while (!re.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    return text;
  };
  const parse = (block: string) => ({ event: /event: (.*)/.exec(block)![1], data: JSON.parse(/data: (.*)/.exec(block)![1]!) });
  // An instance list that waits, so that the first scan ends when the test says so.
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inst2: any = { ...instances, claudeHome: "/nonexistent-claude-home", list: async () => (await gate, []) };
    return { inst2, release };
  };
  const fakeSource = () => {
    const calls: string[] = [];
    const source = { start: () => void calls.push("start"), stop: () => void calls.push("stop"), setActive: (a: boolean) => void calls.push(`active:${a}`) };
    return { source, calls };
  };

  test("the snapshot holds sessions null before the first scan, then the latest list", async () => {
    const { inst2, release } = gated();
    const ev = new NodeEvents();
    const a = createNodeApp({ cfg, instances: inst2, auth, events: ev, sessionSource: fakeSource().source });
    const r1 = await a.request("/api/events", { headers: ok });
    const reader1 = r1.body!.getReader();
    expect(parse((await readUntil(reader1, /\n\n/)).trim()).data.sessions).toBeNull();
    release();
    const later = parse((await readUntil(reader1, /event: sessions[^]*\n\n/)).split("\n\n").filter((b) => b.includes("event: sessions"))[0]!);
    expect(later.data).toMatchObject({ available: true, sessions: [] });
    await reader1.cancel();
    const r2 = await a.request("/api/events", { headers: ok });
    const reader2 = r2.body!.getReader();
    const snap = parse((await readUntil(reader2, /\n\n/)).trim());
    expect(snap.data.sessions).toEqual(ev.latestSessions()!);
    expect(snap.data.sessions).toMatchObject({ available: true, sessions: [] });
    await reader2.cancel();
  });

  test("a later sessions event is written as event: sessions", async () => {
    const ev = new NodeEvents();
    const a = createNodeApp({ cfg, instances, auth, events: ev, sessionSource: fakeSource().source });
    const r = await a.request("/api/events", { headers: ok });
    const reader = r.body!.getReader();
    await readUntil(reader, /\n\n/);
    const payload = { scannedAt: "t", available: true, sessions: [] };
    ev.emit({ type: "sessions", ...payload });
    expect(await readUntil(reader, /\n\n/)).toBe(`event: sessions\ndata: ${JSON.stringify(payload)}\n\n`);
    await reader.cancel();
  });

  test("POST /api/sessions/watch answers 204 and sets the index active", async () => {
    const { source, calls } = fakeSource();
    const a = createNodeApp({ cfg, instances: { ...instances, claudeHome: "/nonexistent-claude-home" } as any, auth, sessionSource: source });
    const res = await a.request("/api/sessions/watch", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(204);
    expect(calls).toContain("active:true");
  });

  test("POST /api/sessions/watch writes no audit line, and another write still does", async () => {
    const a = createNodeApp({ cfg, instances, auth, sessionSource: fakeSource().source });
    logged.length = 0;
    expect((await a.request("/api/sessions/watch", { method: "POST", headers: json, body: "{}" })).status).toBe(204);
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual([]);
    await a.request("/api/instances", { method: "POST", headers: json, body: JSON.stringify({ path: "/srv/p" }) });
    expect(logged.filter((l) => l.startsWith("audit")).map((l) => l.replace(/ \d+$/, ""))).toEqual(["audit caller=secret POST /api/instances"]);
  });

  test("POST /api/sessions/watch without JSON content type answers 415", async () => {
    const { source, calls } = fakeSource();
    const a = createNodeApp({ cfg, instances, auth, sessionSource: source });
    const res = await a.request("/api/sessions/watch", { method: "POST", headers: ok, body: "{}" });
    expect(res.status).toBe(415);
    expect(calls).not.toContain("active:true");
  });
});

describe("node audit with the acting user", () => {
  const withAct = (act: unknown) =>
    createNodeApp({ cfg, instances, auth: async (c, next) => (c.set("caller" as never, "hub" as never), c.set("act" as never, act as never), next()) });
  const post = (a: ReturnType<typeof withAct>) => a.request("/api/instances", { method: "POST", headers: json, body: JSON.stringify({ path: "/srv/p" }) });
  test("the audit line shows the acting user and role", async () => {
    await post(withAct({ actSub: "kir", actRole: "write" }));
    expect(logged).toContain("audit caller=hub act=kir/write POST /api/instances 201");
  });
  test("an odd name is quoted, so that it cannot add a line", async () => {
    await post(withAct({ actSub: "a\naudit caller=x", actRole: "write" }));
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(['audit caller=hub act="a\\naudit caller=x"/write POST /api/instances 201']);
  });
  test("a proof with no acting user adds no act field", async () => {
    await post(withAct({}));
    expect(logged).toContain("audit caller=hub POST /api/instances 201");
  });
});
