import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HttpError, type Instances } from "../src/instances";
import { onError } from "../src/app";
import { sessionApi } from "../src/sessionapi";
import type { TranscriptFs } from "../src/transcriptfs";

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

function build(opts: { home?: boolean; roots?: Record<string, string>; path?: string; live?: Parameters<typeof sessionApi>[0]["live"] } = {}) {
  const inst = {
    claudeHome: async (id: string) => {
      if (id !== ID) throw new HttpError(404, "instance not found");
      return { path: opts.path ?? root, home: "/home/x" };
    },
  } as unknown as Instances;
  if (opts.home === false) delete (inst as { claudeHome?: unknown }).claudeHome;
  const app = new Hono();
  app.route("/instances/:id/sessions", sessionApi({ instances: inst, fs: transcripts(opts.roots ?? { [SID]: root }), ...(opts.live ? { live: opts.live } : {}) }));
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
  test("GET sessions marks a running session live, read from the instance user's home", async () => {
    const homes: string[] = [];
    const live = async (h: string) => (homes.push(h), new Map([[SID, { status: "busy" as const, remoteControl: true, name: "app name" }]]));
    const r = await get(build({ live, roots: { [SID]: root, [SID2]: root } }), "");
    const list = (await r.json()) as { id: string; name?: string; live?: unknown }[];
    expect(homes).toEqual(["/home/x"]);
    expect(list.find((s) => s.id === SID)).toMatchObject({ name: "app name", live: { status: "busy", remoteControl: true } });
    expect(list.find((s) => s.id === SID2)?.live).toBeUndefined();
  });
  test("GET sessions still answers when the running-session files cannot be read", async () => {
    const r = await get(build({ live: async () => { throw new Error("EACCES"); } }), "");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { live?: unknown }[])[0]?.live).toBeUndefined();
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
    // The swap runs after PinnedRoot.pin has checked the real root, as a racing instance user would.
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

describe("touched files outside the session folder (abs)", () => {
  // The only gate for a file outside the root is exact membership in the session's touched list.
  let out: string;
  let n = 0;
  const useLine = (tool: string, p: string, id: string) =>
    JSON.stringify({ type: "assistant", timestamp: "2026-11-11T10:01:00Z", message: { content: [{ type: "tool_use", id, name: tool, input: tool === "NotebookEdit" ? { notebook_path: p } : { file_path: p } }] } });
  const resultLine = (id: string, extra: object = {}) =>
    JSON.stringify({ type: "user", timestamp: "2026-11-11T10:01:01Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] } });
  /** One session at `root` whose transcript wrote `paths` (a Write each, with a successful result), then `extra` lines. */
  function withTouched(paths: string[], extra: string[] = []): TranscriptFs {
    const first = JSON.stringify({ type: "user", cwd: root, timestamp: "2026-11-11T10:00:00Z" });
    return {
      readdir: async () => [`${SID}.jsonl`],
      stat: async () => ({ mtimeMs: 1000 }),
      lines: async function* () {
        yield first;
        for (const p of paths) {
          const id = `toolu_${++n}`;
          yield useLine("Write", p, id);
          yield resultLine(id);
        }
        yield* extra;
      },
    };
  }
  function app(paths: string[], deps: Partial<Parameters<typeof sessionApi>[0]> = {}, extra: string[] = []) {
    const inst = { claudeHome: async () => ({ path: root, home: "/home/x" }) } as unknown as Instances;
    const a = new Hono();
    a.route("/instances/:id/sessions", sessionApi({ instances: inst, fs: withTouched(paths, extra), ...deps }));
    a.onError(onError);
    return a;
  }
  const q = (abs: string) => `abs=${encodeURIComponent(abs)}`;
  const both = async (a: Hono, query: string) => {
    const f = await get(a, `/${SID}/file?${query}`);
    const d = await get(a, `/${SID}/download?${query}`);
    return { f, d, fBody: await f.text(), dBody: await d.text() };
  };

  beforeEach(async () => {
    out = join(dir, "outside");
    await mkdir(out);
    await writeFile(join(out, "t.txt"), "touched outside");
    await writeFile(join(out, "sibling.txt"), "secret sibling");
  });

  test("a touched path outside the root is previewed and downloaded byte for byte", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13, 0x80, 0x7f]);
    await writeFile(join(out, "b.bin"), bytes);
    const a = app([join(out, "t.txt"), join(out, "b.bin")]);
    const f = await get(a, `/${SID}/file?${q(join(out, "t.txt"))}`);
    expect(f.status).toBe(200);
    expect(f.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await f.json()).toMatchObject({ name: "t.txt", kind: "text", text: "touched outside" });
    const d = await get(a, `/${SID}/download?${q(join(out, "b.bin"))}`);
    expect(d.status).toBe(200);
    expect(d.headers.get("content-type")).toBe("application/octet-stream");
    expect(d.headers.get("content-disposition")).toBe(`attachment; filename="b.bin"; filename*=UTF-8''b.bin`);
    expect(d.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await d.arrayBuffer())).toEqual(bytes);
  });

  test("a Write or Edit that was denied, failed or got no result is listed but never served", async () => {
    const t = join(out, "t.txt");
    const cases: Record<string, string[]> = {
      denied: [useLine("Edit", t, "d1"), resultLine("d1", { is_error: true, content: "Permission for this action was denied" })],
      failed: [useLine("Write", t, "e1"), resultLine("e1", { is_error: true })],
      "no result": [useLine("Write", t, "n1")],
      "result for another id": [useLine("Write", t, "a1"), resultLine("a2")],
      "result before its use": [resultLine("o1"), useLine("Write", t, "o1")],
      "result in a request copy": [useLine("Write", t, "b1"), JSON.stringify({ type: "api-request-blob", message: { content: [{ type: "tool_result", tool_use_id: "b1" }] } })],
      "duplicate id": [useLine("Write", join(out, "sibling.txt"), "x1"), useLine("Write", t, "x1"), resultLine("x1")],
    };
    for (const [name, lines] of Object.entries(cases)) {
      const a = app([], {}, lines);
      const listed = (await (await get(a, `/${SID}/touched`)).json()) as { path: string; confirmed: boolean }[];
      expect({ name, listed: listed.find((f) => f.path === t)?.confirmed }).toEqual({ name, listed: false });
      const { f, d } = await both(a, q(t));
      expect({ name, f: f.status, d: d.status }).toEqual({ name, f: 404, d: 404 });
    }
  });

  test("a later failed call to a written path keeps it served", async () => {
    const t = join(out, "t.txt");
    const a = app([t], {}, [useLine("Edit", t, "late"), resultLine("late", { is_error: true })]);
    const { f, d, dBody } = await both(a, q(t));
    expect([f.status, d.status, dBody]).toEqual([200, 200, "touched outside"]);
  });

  test("an abs under /proc, /sys or /dev is 404 even when written", async () => {
    const paths = ["/proc/version", "/proc/self/status", "/sys/kernel/mm/transparent_hugepage/enabled", "/dev/null", "/dev/zero"].filter((p) => existsSync(p));
    expect(paths.length).toBeGreaterThan(1);
    const a = app(paths);
    for (const p of paths) {
      const { f, d } = await both(a, q(p));
      expect({ p, f: f.status, d: d.status }).toEqual({ p, f: 404, d: 404 });
    }
  });

  test("the touched answer leaves out /proc, /sys, /dev and state folder files, and keeps a normal outside file", async () => {
    const state = join(dir, "state");
    await mkdir(state);
    await writeFile(join(state, "key.pem"), "secret");
    await symlink(state, join(dir, "state-link"));
    const t = join(out, "t.txt");
    const listed = ["/proc/version", "/sys/kernel/x", "/dev/null", join(state, "key.pem"), t];
    for (const dirs of [[state], [join(dir, "state-link")]]) {
      const a = app(listed, { refuseDirs: dirs });
      const touched = (await (await get(a, `/${SID}/touched`)).json()) as { path: string }[];
      expect({ dirs, paths: touched.map((f) => f.path) }).toEqual({ dirs, paths: [t] });
      for (const p of listed.slice(0, 4)) {
        const { f, d } = await both(a, q(p));
        expect({ p, f: f.status, d: d.status }).toEqual({ p, f: 404, d: 404 });
      }
      expect((await get(a, `/${SID}/file?${q(t)}`)).status).toBe(200);
    }
  });

  test("an abs inside a refused state folder is 404, also when the folder is reached through a link", async () => {
    const t = join(out, "t.txt");
    for (const dirs of [[out], [`${out}/`], [join(dir, "state-link")]]) {
      await rm(join(dir, "state-link"), { force: true });
      await symlink(out, join(dir, "state-link"));
      const { f, d } = await both(app([t], { refuseDirs: dirs }), q(t));
      expect({ dirs, f: f.status, d: d.status }).toEqual({ dirs, f: 404, d: 404 });
    }
    expect((await get(app([t], { refuseDirs: [join(dir, "missing")] }), `/${SID}/file?${q(t)}`)).status).toBe(200);
  });

  test("an abs that has a second hard link is 404", async () => {
    const t = join(out, "t.txt");
    await link(t, join(out, "t2.txt"));
    const { f, d } = await both(app([t, join(out, "t2.txt")]), q(join(out, "t2.txt")));
    expect([f.status, d.status]).toEqual([404, 404]);
    expect((await get(app([t]), `/${SID}/file?${q(t)}`)).status).toBe(404);
  });

  test("on Windows a UNC or device abs is 404 and never opened, a drive path matches without regard to case", async () => {
    const calls: [string, string][] = [];
    const previewIn = (async (r: string, n: string) => (calls.push([r, n]), { name: n, size: 0, kind: "text", text: "" })) as never;
    const listed = ["\\\\srv\\share\\a.txt", "//srv/share/b.txt", "\\\\?\\C:\\c.txt", "\\\\.\\C:\\d.txt", "C:\\Users\\U\\T.txt"];
    const a = app(listed, { platform: "win32", previewIn });
    const touched = (await (await get(a, `/${SID}/touched`)).json()) as { path: string }[];
    expect(touched.map((t) => t.path)).toEqual(["C:\\Users\\U\\T.txt"]);
    for (const p of listed.slice(0, 4)) expect({ p, s: (await get(a, `/${SID}/file?${q(p)}`)).status }).toEqual({ p, s: 404 });
    expect(calls).toEqual([]);
    expect((await get(a, `/${SID}/file?${q("c:\\users\\u\\t.TXT")}`)).status).toBe(200);
    expect(calls).toEqual([["C:\\Users\\U", "T.txt"]]);
  });

  test("touched and the abs gate read the transcript that rootOf found, without a second scan", async () => {
    let readdirs = 0;
    const fs = withTouched([join(out, "t.txt")]);
    const counted = { ...fs, readdir: async (d: string) => (readdirs++, fs.readdir(d)) };
    const a = app([], { fs: counted });
    await get(a, `/${SID}/files`);
    const one = readdirs;
    readdirs = 0;
    expect((await get(a, `/${SID}/touched`)).status).toBe(200);
    expect(readdirs).toBe(one);
    readdirs = 0;
    expect((await get(a, `/${SID}/file?${q(join(out, "t.txt"))}`)).status).toBe(200);
    expect(readdirs).toBe(one);
  });

  test("a touched path inside the root is also served by abs", async () => {
    const r = await get(app([join(root, "a.txt")]), `/${SID}/file?${q(join(root, "a.txt"))}`);
    expect(await r.json()).toMatchObject({ text: "hello" });
  });

  test("a path that is not on the touched list is 404 for preview and download", async () => {
    const a = app([join(out, "t.txt")]);
    for (const p of ["/etc/hostname", "/etc/passwd", join(out, "sibling.txt"), out, join(out, "t.txt.bak"), join(root, "a.txt"), "/"]) {
      const { f, d, fBody, dBody } = await both(a, q(p));
      expect(f.status).toBe(404);
      expect(d.status).toBe(404);
      expect(JSON.parse(fBody)).toEqual({ error: "file was not touched by this session" });
      expect(JSON.parse(dBody)).toEqual({ error: "file was not touched by this session" });
    }
  });

  test("the not-touched answer is the same for a file that exists and one that does not", async () => {
    const a = app([join(out, "t.txt")]);
    const x = await both(a, q("/etc/hostname"));
    const y = await both(a, q("/nonexistent-dir-xyz/nope"));
    expect([x.f.status, x.d.status]).toEqual([y.f.status, y.d.status]);
    expect(x.fBody).toBe(y.fBody);
    expect(x.dBody).toBe(y.dBody);
    expect([...x.f.headers.entries()]).toEqual([...y.f.headers.entries()]);
  });

  test("an empty touched list serves nothing", async () => {
    const { f, d } = await both(app([]), q(join(out, "t.txt")));
    expect(f.status).toBe(404);
    expect(d.status).toBe(404);
  });

  test("abs with .. segments is allowed only when it resolves exactly to a touched path", async () => {
    const a = app([join(out, "t.txt")]);
    const ok = await get(a, `/${SID}/download?${q(`${out}/../outside/./t.txt`)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("touched outside");
    const ok2 = await get(a, `/${SID}/file?${q(`/${out}//t.txt`)}`);
    expect(ok2.status).toBe(200);
    await ok2.arrayBuffer();
    for (const p of [`${out}/../outside/sibling.txt`, `${out}/t.txt/../sibling.txt`, `${root}/../outside/sibling.txt`]) {
      const { f, d } = await both(a, q(p));
      expect(f.status).toBe(404);
      expect(d.status).toBe(404);
    }
  });

  test("encoding tricks do not reach an untouched file", async () => {
    const a = app([join(out, "t.txt")]);
    // Double-encoded dots stay literal names.
    for (const query of [`abs=${encodeURIComponent(`${out}/%2e%2e/outside/sibling.txt`)}`, `abs=${out}/%252e%252e/sibling.txt`]) {
      const { f, d } = await both(a, query);
      expect(f.status).toBe(404);
      expect(d.status).toBe(404);
    }
    // Case differs: a different file on Linux.
    if (process.platform === "linux") {
      const { f, d } = await both(a, q(join(out, "T.txt")));
      expect(f.status).toBe(404);
      expect(d.status).toBe(404);
    }
  });

  test("a repeated abs uses only the first value, which is checked", async () => {
    const a = app([join(out, "t.txt")]);
    const r = await get(a, `/${SID}/download?${q(join(out, "sibling.txt"))}&${q(join(out, "t.txt"))}`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("secret");
  });

  test("a touched path whose final name is a symlink is refused, even to a sibling", async () => {
    await symlink(join(out, "sibling.txt"), join(out, "link-sib.txt"));
    await symlink("/etc/hostname", join(out, "link-etc.txt"));
    const a = app([join(out, "link-sib.txt"), join(out, "link-etc.txt")]);
    for (const n of ["link-sib.txt", "link-etc.txt"]) {
      const { f, d, fBody, dBody } = await both(a, q(join(out, n)));
      expect([403, 404]).toContain(f.status);
      expect([403, 404]).toContain(d.status);
      expect(fBody + dBody).not.toContain("secret sibling");
    }
  });

  test("a touched path whose parent folder is a symlink is refused", async () => {
    // The parent was a real folder when Claude wrote the file, then became a link to a folder with a same-named secret.
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "t.txt"), "secret elsewhere");
    const linked = join(dir, "linked");
    await symlink(elsewhere, linked);
    const a = app([join(linked, "t.txt")]);
    const { f, d, fBody, dBody } = await both(a, q(join(linked, "t.txt")));
    expect([403, 404]).toContain(f.status);
    expect([403, 404]).toContain(d.status);
    expect(fBody + dBody).not.toContain("secret elsewhere");
  });

  test("a parent folder swapped for a symlink between the check and the open is refused", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "t.txt"), "secret elsewhere");
    const swap = async () => {
      await rename(out, out + ".old");
      await symlink(elsewhere, out);
    };
    const restore = async () => {
      await rm(out, { force: true });
      await rename(out + ".old", out);
    };
    const mod = await import("../src/sessionfs");
    const a = app([join(out, "t.txt")], {
      openDownload: (r, rel, hooks) => mod.openDownload(r, rel, { ...hooks, beforeOpen: swap }),
      previewIn: (r, rel, hooks) => mod.previewIn(r, rel, { ...hooks, beforeOpen: swap }),
    });
    const d = await get(a, `/${SID}/download?${q(join(out, "t.txt"))}`);
    expect([403, 404]).toContain(d.status);
    expect(await d.text()).not.toContain("secret");
    await restore();
    const f = await get(a, `/${SID}/file?${q(join(out, "t.txt"))}`);
    expect([403, 404]).toContain(f.status);
    expect(await f.text()).not.toContain("secret");
    await restore();
  });

  test("a final name swapped for a symlink to a sibling between the check and the open is refused", async () => {
    const toLink = async (real: string) => {
      await rename(real, real + ".old");
      await symlink(join(out, "sibling.txt"), real);
    };
    const mod = await import("../src/sessionfs");
    const a = app([join(out, "t.txt")], { openDownload: (r, rel, hooks) => mod.openDownload(r, rel, { ...hooks, beforeOpen: toLink }) });
    const d = await get(a, `/${SID}/download?${q(join(out, "t.txt"))}`);
    expect([403, 404]).toContain(d.status);
    expect(await d.text()).not.toContain("secret");
  });

  test("a touched path that was deleted, or whose folder is gone, is 404", async () => {
    const a = app([join(out, "t.txt"), join(dir, "gone", "x.txt")]);
    await rm(join(out, "t.txt"));
    for (const p of [join(out, "t.txt"), join(dir, "gone", "x.txt")]) {
      const { f, d } = await both(a, q(p));
      expect(f.status).toBe(404);
      expect(d.status).toBe(404);
    }
  });

  test("a touched folder is not a file", async () => {
    const { f, d } = await both(app([out]), q(out));
    expect(f.status).toBe(400);
    expect(d.status).toBe(400);
  });

  test("bad requests are 400: both, neither, relative, empty, NUL, control, too long", async () => {
    const a = app([join(out, "t.txt")]);
    const bad = [
      `path=a.txt&${q(join(out, "t.txt"))}`,
      `path=&${q(join(out, "t.txt"))}`,
      "",
      "abs=",
      q("outside/t.txt"),
      q("../outside/t.txt"),
      q(`${out}/t\u0000.txt`),
      q(`${out}/t\n.txt`),
      q("/" + "a".repeat(4096)),
    ];
    for (const query of bad) {
      const { f, d } = await both(a, query);
      expect([query, f.status]).toEqual([query, 400]);
      expect([query, d.status]).toEqual([query, 400]);
    }
  });

  test("files (the folder browser) refuses abs with 400", async () => {
    const r = await get(app([out]), `/${SID}/files?${q(out)}`);
    expect(r.status).toBe(400);
    await r.arrayBuffer();
  });
});
