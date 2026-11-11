import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HttpError, type Instances } from "../src/instances";
import { onError } from "../src/app";
import { sessionApi } from "../src/sessionapi";
import type { TranscriptFs } from "../src/sessions";

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";
const SID2 = "11111111-2222-3333-4444-666666666666";

let dir: string;
let root: string;

/** A transcript store with one session per entry of `roots`. */
function transcripts(roots: Record<string, string>): TranscriptFs {
  const line = (cwd: string) => JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T10:00:00Z", sessionId: "x" });
  return {
    readdir: async () => Object.keys(roots).map((s) => `${s}.jsonl`),
    stat: async () => ({ mtimeMs: 1000 }),
    lines: async function* (p: string) {
      const sid = Object.keys(roots).find((s) => p.endsWith(`${s}.jsonl`))!;
      yield line(roots[sid]!);
    },
  };
}

function build(opts: { home?: boolean; roots?: Record<string, string>; path?: string } = {}) {
  const inst = {
    claudeHome: async (id: string) => {
      if (id !== ID) throw new HttpError(404, "instance not found");
      return { path: opts.path ?? root, home: "/home/x" };
    },
  } as unknown as Instances;
  if (opts.home === false) delete (inst as { claudeHome?: unknown }).claudeHome;
  const app = new Hono();
  app.route("/instances/:id/sessions", sessionApi({ instances: inst, fs: transcripts(opts.roots ?? { [SID]: root }) }));
  app.onError(onError);
  return app;
}
const get = (app: Hono, p: string, init?: RequestInit) => app.request(`/instances/${ID}/sessions${p}`, init);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sapi-"));
  root = join(dir, "work");
  await mkdir(root);
  await writeFile(join(root, "a.txt"), "hello");
  await writeFile(join(root, "naïve é.txt"), "x");
  await writeFile(join(root, ".hid"), "h");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("sessions list", () => {
  test("GET sessions returns the sessions", async () => {
    const r = await get(build(), "");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { id: string }[]).map((s) => s.id)).toEqual([SID]);
  });
  test("GET sessions returns 404 for an unknown instance", async () => {
    const r = await build().request(`/instances/aaaaaaaaaaaa/sessions`);
    expect(r.status).toBe(404);
  });
  test("a bad instance id is 400", async () => {
    expect((await build().request(`/instances/nope/sessions`)).status).toBe(400);
  });
  test("GET sessions returns 501 when the backend has no claudeHome", async () => {
    const r = await get(build({ home: false }), "");
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: "sessions are not available on this host" });
  });
  test("a bad session id is 400, an unknown one is 404", async () => {
    expect((await get(build(), "/zzz/files")).status).toBe(400);
    const r = await get(build(), `/${SID2}/files`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "session not found" });
  });
});

describe("files", () => {
  test("GET files lists the root and hides dot names unless hidden=1", async () => {
    const names = async (q: string) => ((await (await get(build(), `/${SID}/files${q}`)).json()) as { entries: { name: string }[] }).entries.map((e) => e.name);
    expect(await names("")).not.toContain(".hid");
    expect(await names("?hidden=1")).toContain(".hid");
  });
  test("GET files returns 404 when the session root no longer exists", async () => {
    const r = await get(build({ roots: { [SID]: join(root, "gone") } }), `/${SID}/files`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "session folder not found" });
  });
  test("a filesystem root as session root is 404", async () => {
    const r = await get(build({ roots: { [SID]: "/" }, path: "/" }), `/${SID}/files`);
    expect(r.status).toBe(404);
  });
  test("a request with path=../x returns 403", async () => {
    expect((await get(build(), `/${SID}/files?path=${encodeURIComponent("../x")}`)).status).toBe(403);
    expect((await get(build(), `/${SID}/file?path=${encodeURIComponent("../x")}`)).status).toBe(403);
    expect((await get(build(), `/${SID}/download?path=${encodeURIComponent("../x")}`)).status).toBe(403);
  });
  test("GET touched returns a list", async () => {
    const r = await get(build(), `/${SID}/touched`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});

describe("file and download", () => {
  test("GET file returns the Preview as JSON, never as HTML", async () => {
    const r = await get(build(), `/${SID}/file?path=a.txt`);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.json()).toMatchObject({ name: "a.txt", kind: "text", text: "hello" });
  });
  test("GET download sends attachment, octet-stream, and content-length", async () => {
    const r = await get(build(), `/${SID}/download?path=a.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-length")).toBe("5");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    expect(await r.text()).toBe("hello");
  });
  test("GET download names a file with non-ASCII letters through filename*", async () => {
    const r = await get(build(), `/${SID}/download?path=${encodeURIComponent("naïve é.txt")}`);
    const cd = r.headers.get("content-disposition")!;
    expect(cd).toContain(`filename*=UTF-8''na%C3%AFve%20%C3%A9.txt`);
    expect(cd).toMatch(/filename="[\x20-\x7e]*"/);
    await r.arrayBuffer();
  });
  test("download with inline=1 is text/plain, nosniff, inline", async () => {
    const r = await get(build(), `/${SID}/download?path=a.txt&inline=1`);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(await r.text()).toBe("hello");
  });
  test("GET download stops reading when the request aborts", async () => {
    const mod = await import("../src/sessionapi");
    let closed = 0;
    let cancelled = 0;
    const app = new Hono();
    app.route("/instances/:id/sessions", mod.sessionApi({
      instances: { claudeHome: async () => ({ path: root, home: "/h" }) } as unknown as Instances,
      fs: transcripts({ [SID]: root }),
      openDownload: async () => ({
        name: "a.txt", size: 5, close: () => { closed++; },
        stream: new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } }),
      }),
    }));
    app.onError(onError);
    const ac = new AbortController();
    const r = await app.request(`/instances/${ID}/sessions/${SID}/download?path=a.txt`, { signal: ac.signal });
    expect(r.status).toBe(200);
    ac.abort();
    await new Promise((res) => setTimeout(res, 20));
    expect(closed).toBeGreaterThan(0);
    expect(cancelled).toBe(1);
  });
});
