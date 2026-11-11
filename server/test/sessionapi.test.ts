import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

describe("a session root reached through a symlink", () => {
  // The instance user writes the transcript, so its cwd is not trusted: only the real place of the folder counts.
  const all = (app: Hono, sid = SID) => Promise.all([
    get(app, `/${sid}/files`),
    get(app, `/${sid}/files?path=etc`),
    get(app, `/${sid}/file?path=${encodeURIComponent("etc/hostname")}`),
    get(app, `/${sid}/download?path=${encodeURIComponent("etc/hostname")}`),
  ]);
  const refused = async (app: Hono, sid = SID) => {
    for (const r of await all(app, sid)) {
      expect([403, 404]).toContain(r.status);
      await r.arrayBuffer();
    }
  };

  test("a cwd at a link to / is refused for list, file and download", async () => {
    await symlink("/", join(root, "link"));
    await refused(build({ roots: { [SID]: join(root, "link") } }));
  });
  test("a cwd below a link to / is refused", async () => {
    await symlink("/", join(root, "link"));
    await refused(build({ roots: { [SID]: join(root, "link", "etc") } }));
    const r = await get(build({ roots: { [SID]: join(root, "link", "etc") } }), `/${SID}/file?path=hostname`);
    expect([403, 404]).toContain(r.status);
  });
  test("a cwd at a link to a folder outside the instance is refused", async () => {
    const out = join(dir, "outside");
    await mkdir(join(out, "etc"), { recursive: true });
    await writeFile(join(out, "etc", "hostname"), "secret");
    await symlink(out, join(root, "link"));
    await refused(build({ roots: { [SID]: join(root, "link") } }));
  });
  test("a cwd with .. segments that leaves the instance folder is refused", async () => {
    await mkdir(join(dir, "outside", "etc"), { recursive: true });
    await writeFile(join(dir, "outside", "etc", "hostname"), "secret");
    await refused(build({ roots: { [SID]: join(root, "..", "outside") } }));
    await refused(build({ roots: { [SID]: `${root}/..` } }));
  });
  test("a cwd of link/.. stays at the instance folder, not the link target's parent", async () => {
    await mkdir(join(dir, "outside", "inner"), { recursive: true });
    await writeFile(join(dir, "outside", "leak.txt"), "secret");
    await symlink(join(dir, "outside", "inner"), join(root, "link"));
    const app = build({ roots: { [SID]: `${root}/link/..` } });
    const r = await get(app, `/${SID}/files`);
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { entries: { name: string }[] }).entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).not.toContain("leak.txt");
    expect([403, 404]).toContain((await get(app, `/${SID}/file?path=leak.txt`)).status);
  });
  test("a work tree folder that is a link to / is refused", async () => {
    await mkdir(join(root, ".claude", "worktrees"), { recursive: true });
    await symlink("/", join(root, ".claude", "worktrees", "x"));
    await refused(build({ roots: { [SID]: join(root, ".claude", "worktrees", "x") } }));
  });
  test("a worktrees folder that is a link to / is refused", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await symlink("/", join(root, ".claude", "worktrees"));
    await refused(build({ roots: { [SID]: join(root, ".claude", "worktrees", "etc") } }));
  });
  test("an instance folder replaced by a link is refused", async () => {
    const real = join(dir, "real");
    await mkdir(join(real, "etc"), { recursive: true });
    await writeFile(join(real, "etc", "hostname"), "secret");
    const linked = join(dir, "linked");
    await symlink(real, linked);
    await refused(build({ roots: { [SID]: linked }, path: linked }));
    await rm(linked);
    await symlink("/", linked);
    await refused(build({ roots: { [SID]: linked }, path: linked }));
  });
  test("a cwd at a link that resolves inside the instance folder still works", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "in.txt"), "inside");
    await symlink(join(root, "sub"), join(root, "link"));
    const app = build({ roots: { [SID]: join(root, "link") } });
    const l = await get(app, `/${SID}/files`);
    expect(l.status).toBe(200);
    expect(((await l.json()) as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(["in.txt"]);
    const f = await get(app, `/${SID}/file?path=in.txt`);
    expect(await f.json()).toMatchObject({ text: "inside" });
    const d = await get(app, `/${SID}/download?path=in.txt`);
    expect(await d.text()).toBe("inside");
  });
  test("a work tree session whose folder links out of the work trees folder is refused", async () => {
    // Filed under the work tree transcript folder, so it must stay inside <path>/.claude/worktrees.
    const wtDir = `${root.replace(/[^a-zA-Z0-9]/g, "-")}--claude-worktrees-x`;
    const line = (cwd: string) => JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T10:00:00Z" });
    const mk = (cwd: string): TranscriptFs => ({
      readdir: async (d) => (d.endsWith("projects") ? [wtDir] : d.endsWith(wtDir) ? [`${SID}.jsonl`] : []),
      stat: async () => ({ mtimeMs: 1000 }),
      lines: async function* () { yield line(cwd); },
    });
    const wt = join(root, ".claude", "worktrees", "x");
    await mkdir(join(root, ".claude", "worktrees"), { recursive: true });
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "s.txt"), "s");
    await symlink(join(root, "sub"), wt);
    const app = new Hono();
    const inst = { claudeHome: async () => ({ path: root, home: "/home/x" }) } as unknown as Instances;
    app.route("/instances/:id/sessions", sessionApi({ instances: inst, fs: mk(wt) }));
    app.onError(onError);
    expect([403, 404]).toContain((await get(app, `/${SID}/download?path=s.txt`)).status);
    await rm(wt);
    await mkdir(wt);
    await writeFile(join(wt, "w.txt"), "w");
    expect(await (await get(app, `/${SID}/download?path=w.txt`)).text()).toBe("w");
  });
  test("a session folder swapped for a link between the root check and the read is refused", async () => {
    const sub = join(root, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "s.txt"), "s");
    const out = join(dir, "outside");
    await mkdir(out);
    await writeFile(join(out, "s.txt"), "secret");
    const inst = { claudeHome: async () => ({ path: root, home: "/home/x" }) } as unknown as Instances;
    const app = new Hono();
    // The swap runs after rootOf has checked the real root, as a racing instance user would.
    const mod = await import("../src/sessionfs");
    app.route("/instances/:id/sessions", sessionApi({
      instances: inst,
      fs: transcripts({ [SID]: sub }),
      openDownload: async (r, rel, hooks) => {
        await rm(sub, { recursive: true });
        await symlink(out, sub);
        return mod.openDownload(r, rel, hooks);
      },
    }));
    app.onError(onError);
    const r = await get(app, `/${SID}/download?path=s.txt`);
    expect([403, 404]).toContain(r.status);
    expect(await r.text()).not.toContain("secret");
  });
  test("a real work tree inside the instance folder works", async () => {
    const wt = join(root, ".claude", "worktrees", "x");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, "w.txt"), "wt");
    const app = build({ roots: { [SID]: wt } });
    expect(await (await get(app, `/${SID}/download?path=w.txt`)).text()).toBe("wt");
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
  test("download ignores inline=1: still octet-stream, nosniff, sandboxed, attachment", async () => {
    const r = await get(build(), `/${SID}/download?path=a.txt&inline=1`);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
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
