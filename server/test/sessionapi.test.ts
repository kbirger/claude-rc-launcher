import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onError } from "../src/app";
import { HttpError } from "../src/instances";
import type { Instances } from "../src/instances";
import { sessionApi } from "../src/sessionapi";
import type { TranscriptFs } from "../src/transcriptfs";
import { defined } from "./support";

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";
const SID2 = "11111111-2222-3333-4444-666666666666";

let dir: string;
let root: string;

/** A transcript store with one session per entry of `roots`. */
function transcripts(roots: Record<string, string>): TranscriptFs {
  const line = (cwd: string) =>
    JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T10:00:00Z", sessionId: "x" });
  return {
    readdir: () => Promise.resolve(Object.keys(roots).map((key) => `${key}.jsonl`)),
    stat: () => Promise.resolve({ mtimeMs: 1000 }),
    lines: async function* (path: string) {
      const sid = defined(Object.keys(roots).find((key) => path.endsWith(`${key}.jsonl`)));
      yield line(roots[sid]);
    },
  };
}

function build(
  opts: {
    home?: boolean;
    roots?: Record<string, string>;
    path?: string;
    live?: Parameters<typeof sessionApi>[0]["live"];
    run?: Parameters<typeof sessionApi>[0]["run"];
    identity?: object;
  } = {},
) {
  const inst = {
    claudeHome: (id: string) => {
      if (id !== ID) return Promise.reject(new HttpError(404, "instance not found"));
      return Promise.resolve({
        path: opts.path ?? root,
        home: "/home/x",
        ...(opts.identity ? { identity: opts.identity } : {}),
      });
    },
  } as unknown as Instances;
  if (opts.home === false) delete (inst as { claudeHome?: unknown }).claudeHome;
  const app = new Hono();
  app.route(
    "/instances/:id/sessions",
    sessionApi({
      instances: inst,
      fs: transcripts(opts.roots ?? { [SID]: root }),
      ...(opts.live ? { live: opts.live } : {}),
      ...(opts.run ? { run: opts.run } : {}),
    }),
  );
  app.onError(onError);
  return app;
}

const get = (app: Hono, item: string, init?: RequestInit) => app.request(`/instances/${ID}/sessions${item}`, init);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sapi-"));
  root = join(dir, "work");
  await mkdir(root);
  await writeFile(join(root, "a.txt"), "hello");
  await writeFile(join(root, "naïve é.txt"), "x");
  await writeFile(join(root, ".hid"), "h");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sessions list", () => {
  test("GET sessions returns the sessions", async () => {
    const response = await get(build(), "");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }[]).map((item) => item.id)).toEqual([SID]);
  });
  test("GET sessions marks a running session live, read from the instance user's home", async () => {
    const homes: string[] = [];
    const live = (item: string) =>
      Promise.resolve(
        (homes.push(item), new Map([[SID, { status: "busy" as const, remoteControl: true, name: "app name" }]])),
      );
    const response = await get(build({ live, roots: { [SID]: root, [SID2]: root } }), "");
    const list = (await response.json()) as { id: string; name?: string; live?: unknown }[];
    expect(homes).toEqual(["/home/x"]);
    expect(list.find((item) => item.id === SID)).toMatchObject({
      name: "app name",
      live: { status: "busy", remoteControl: true },
    });
    expect(list.find((item) => item.id === SID2)?.live).toBeUndefined();
  });
  test("GET sessions still answers when the running-session files cannot be read", async () => {
    const response = await get(
      build({
        live: () => {
          return Promise.reject(new Error("EACCES"));
        },
      }),
      "",
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { live?: unknown }[])[0]?.live).toBeUndefined();
  });
  test("GET sessions returns 404 for an unknown instance", async () => {
    const response = await build().request(`/instances/aaaaaaaaaaaa/sessions`);
    expect(response.status).toBe(404);
  });
  test("a bad instance id is 400", async () => {
    expect((await build().request(`/instances/nope/sessions`)).status).toBe(400);
  });
  test("GET sessions returns 501 when the backend has no claudeHome", async () => {
    const response = await get(build({ home: false }), "");
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "sessions are not available on this host" });
  });
  test("a bad session id is 400, an unknown one is 404", async () => {
    expect((await get(build(), "/zzz/files")).status).toBe(400);
    const response = await get(build(), `/${SID2}/files`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "session not found" });
  });
});

describe("files", () => {
  test("GET files lists the root and hides dot names unless hidden=1", async () => {
    const names = async (item: string) =>
      ((await (await get(build(), `/${SID}/files${item}`)).json()) as { entries: { name: string }[] }).entries.map(
        (entry) => entry.name,
      );
    expect(await names("")).not.toContain(".hid");
    expect(await names("?hidden=1")).toContain(".hid");
  });
  test("GET files returns 404 when the session root no longer exists", async () => {
    const response = await get(build({ roots: { [SID]: join(root, "gone") } }), `/${SID}/files`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "session folder not found" });
  });
  test("a filesystem root as session root is 404", async () => {
    const response = await get(build({ roots: { [SID]: "/" }, path: "/" }), `/${SID}/files`);
    expect(response.status).toBe(404);
  });
  test("a request with path=../x returns 403", async () => {
    expect((await get(build(), `/${SID}/files?path=${encodeURIComponent("../x")}`)).status).toBe(403);
    expect((await get(build(), `/${SID}/file?path=${encodeURIComponent("../x")}`)).status).toBe(403);
    expect((await get(build(), `/${SID}/download?path=${encodeURIComponent("../x")}`)).status).toBe(403);
  });
  test("GET changed runs git as the instance user in the checked folder and lists what git shows", async () => {
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];

    const run = (cmd: string, args: string[], options?: { cwd?: string }) => {
      calls.push({ cmd, args, cwd: options?.cwd });
      const out = args.includes("rev-parse") ? "\n" : args.includes("status") ? "?? a.txt\0" : "";
      return Promise.resolve({ code: 0, stdout: out, stderr: "" });
    };

    const identity = { home: "/home/x", path: "/usr/bin", uid: 1001, gid: 1001 };
    const response = await get(build({ run, identity }), `/${SID}/changed`);
    expect(response.status).toBe(200);
    const list = (await response.json()) as { path: string; state: string }[];
    expect(list.map((item) => [item.path, item.state])).toEqual([[join(root, "a.txt"), "uncommitted"]]);
    // setpriv switches to the instance user, and git is told not to run a program that the repository names.
    expect(
      calls.every(
        (call) => call.cmd.endsWith("/setpriv") && call.args.includes("1001") && call.args.includes("core.fsmonitor=false"),
      ),
    ).toBe(true);
    expect(calls.every((call) => call.cwd === calls[0].cwd && defined(call.cwd).endsWith("work"))).toBe(true);
  });

  test("GET changed gives 404 for a session that does not exist", async () => {
    expect((await get(build(), `/${SID2}/changed`)).status).toBe(404);
  });

  test("GET touched returns a list", async () => {
    const response = await get(build(), `/${SID}/touched`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});

describe("a session root reached through a symlink", () => {
  // The instance user writes the transcript, so its cwd is not trusted: only the real place of the folder counts.
  const all = (app: Hono, sid = SID) =>
    Promise.all([
      get(app, `/${sid}/files`),
      get(app, `/${sid}/files?path=etc`),
      get(app, `/${sid}/file?path=${encodeURIComponent("etc/hostname")}`),
      get(app, `/${sid}/download?path=${encodeURIComponent("etc/hostname")}`),
    ]);

  const refused = async (app: Hono, sid = SID) => {
    for (const response of await all(app, sid)) {
      expect([403, 404]).toContain(response.status);
      await response.arrayBuffer();
    }
  };

  test("a cwd at a link to / is refused for list, file and download", async () => {
    await symlink("/", join(root, "link"));
    await refused(build({ roots: { [SID]: join(root, "link") } }));
  });
  test("a cwd below a link to / is refused", async () => {
    await symlink("/", join(root, "link"));
    await refused(build({ roots: { [SID]: join(root, "link", "etc") } }));
    const response = await get(build({ roots: { [SID]: join(root, "link", "etc") } }), `/${SID}/file?path=hostname`);
    expect([403, 404]).toContain(response.status);
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
    const response = await get(app, `/${SID}/files`);
    expect(response.status).toBe(200);
    const names = ((await response.json()) as { entries: { name: string }[] }).entries.map((entry) => entry.name);
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
    const response = await get(app, `/${SID}/files`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { entries: { name: string }[] }).entries.map((entry) => entry.name)).toEqual([
      "in.txt",
    ]);
    const reply = await get(app, `/${SID}/file?path=in.txt`);
    expect(await reply.json()).toMatchObject({ text: "inside" });
    const res = await get(app, `/${SID}/download?path=in.txt`);
    expect(await res.text()).toBe("inside");
  });
  test("a work tree session whose folder links out of the work trees folder is refused", async () => {
    // Filed under the work tree transcript folder, so it must stay inside <path>/.claude/worktrees.
    const wtDir = `${root.replace(/[^a-zA-Z0-9]/g, "-")}--claude-worktrees-x`;
    const line = (cwd: string) => JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T10:00:00Z" });
    const mk = (cwd: string): TranscriptFs => ({
      readdir: (path) =>
        Promise.resolve(path.endsWith("projects") ? [wtDir] : path.endsWith(wtDir) ? [`${SID}.jsonl`] : []),
      stat: () => Promise.resolve({ mtimeMs: 1000 }),
      lines: async function* () {
        yield line(cwd);
      },
    });
    const wt = join(root, ".claude", "worktrees", "x");
    await mkdir(join(root, ".claude", "worktrees"), { recursive: true });
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "s.txt"), "s");
    await symlink(join(root, "sub"), wt);
    const app = new Hono();
    const inst = { claudeHome: () => Promise.resolve({ path: root, home: "/home/x" }) } as unknown as Instances;
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
    const inst = { claudeHome: () => Promise.resolve({ path: root, home: "/home/x" }) } as unknown as Instances;
    const app = new Hono();
    // The swap runs after PinnedRoot.pin has checked the real root, as a racing instance user would.
    const mod = await import("../src/sessionfs");
    app.route(
      "/instances/:id/sessions",
      sessionApi({
        instances: inst,
        fs: transcripts({ [SID]: sub }),
        openDownload: async (item, rel, hooks) => {
          await rm(sub, { recursive: true });
          await symlink(out, sub);
          return mod.openDownload(item, rel, hooks);
        },
      }),
    );
    app.onError(onError);
    const response = await get(app, `/${SID}/download?path=s.txt`);
    expect([403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("secret");
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
    const response = await get(build(), `/${SID}/file?path=a.txt`);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toMatchObject({ name: "a.txt", kind: "text", text: "hello" });
  });
  test("GET download sends attachment, octet-stream, and content-length", async () => {
    const response = await get(build(), `/${SID}/download?path=a.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    expect(await response.text()).toBe("hello");
  });
  test("GET download names a file with non-ASCII letters through filename*", async () => {
    const response = await get(build(), `/${SID}/download?path=${encodeURIComponent("naïve é.txt")}`);
    const cd = defined(response.headers.get("content-disposition"));
    expect(cd).toContain(`filename*=UTF-8''na%C3%AFve%20%C3%A9.txt`);
    expect(cd).toMatch(/filename="[\x20-\x7e]*"/);
    await response.arrayBuffer();
  });
  test("download ignores inline=1: still octet-stream, nosniff, sandboxed, attachment", async () => {
    const response = await get(build(), `/${SID}/download?path=a.txt&inline=1`);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    expect(await response.text()).toBe("hello");
  });
  test("GET download stops reading when the request aborts", async () => {
    const mod = await import("../src/sessionapi");
    let closed = 0;
    let cancelled = 0;
    const app = new Hono();
    app.route(
      "/instances/:id/sessions",
      mod.sessionApi({
        instances: { claudeHome: () => Promise.resolve({ path: root, home: "/h" }) } as unknown as Instances,
        fs: transcripts({ [SID]: root }),
        openDownload: () =>
          Promise.resolve({
            name: "a.txt",
            size: 5,
            close: () => {
              closed++;
            },
            stream: new ReadableStream<Uint8Array>({
              pull() {
                return new Promise(() => {});
              },
              cancel() {
                cancelled++;
              },
            }),
          }),
      }),
    );
    app.onError(onError);
    const ac = new AbortController();
    const response = await app.request(`/instances/${ID}/sessions/${SID}/download?path=a.txt`, { signal: ac.signal });
    expect(response.status).toBe(200);
    ac.abort();
    await new Promise((res) => setTimeout(res, 20));
    expect(closed).toBeGreaterThan(0);
    expect(cancelled).toBe(1);
  });
});

describe("touched files outside the session folder (abs)", () => {
  // The only gate for a file outside the root is exact membership in the session's touched list.
  let out: string;
  let count = 0;
  const useLine = (tool: string, item: string, id: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-11T10:01:00Z",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: tool,
            input: tool === "NotebookEdit" ? { notebook_path: item } : { file_path: item },
          },
        ],
      },
    });
  const resultLine = (id: string, extra: object = {}) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-11-11T10:01:01Z",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] },
    });

  /** One session at `root` whose transcript wrote `paths` (a Write each, with a successful result), then `extra` lines. */
  function withTouched(paths: string[], extra: string[] = []): TranscriptFs {
    const first = JSON.stringify({ type: "user", cwd: root, timestamp: "2026-11-11T10:00:00Z" });
    return {
      readdir: () => Promise.resolve([`${SID}.jsonl`]),
      stat: () => Promise.resolve({ mtimeMs: 1000 }),
      lines: async function* () {
        yield first;

        for (const path of paths) {
          const id = `toolu_${++count}`;
          yield useLine("Write", path, id);
          yield resultLine(id);
        }

        yield* extra;
      },
    };
  }

  function app(paths: string[], deps: Partial<Parameters<typeof sessionApi>[0]> = {}, extra: string[] = []) {
    const inst = { claudeHome: () => Promise.resolve({ path: root, home: "/home/x" }) } as unknown as Instances;
    const hono = new Hono();
    hono.route("/instances/:id/sessions", sessionApi({ instances: inst, fs: withTouched(paths, extra), ...deps }));
    hono.onError(onError);
    return hono;
  }

  const helper = (abs: string) => `abs=${encodeURIComponent(abs)}`;

  const both = async (hono: Hono, query: string) => {
    const response = await get(hono, `/${SID}/file?${query}`);
    const reply = await get(hono, `/${SID}/download?${query}`);
    return { file: response, download: reply, fBody: await response.text(), dBody: await reply.text() };
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
    const hono = app([join(out, "t.txt"), join(out, "b.bin")]);
    const response = await get(hono, `/${SID}/file?${helper(join(out, "t.txt"))}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toMatchObject({ name: "t.txt", kind: "text", text: "touched outside" });
    const reply = await get(hono, `/${SID}/download?${helper(join(out, "b.bin"))}`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/octet-stream");
    expect(reply.headers.get("content-disposition")).toBe(`attachment; filename="b.bin"; filename*=UTF-8''b.bin`);
    expect(reply.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await reply.arrayBuffer())).toEqual(bytes);
  });

  test("a Write or Edit that was denied, failed or got no result is listed but never served", async () => {
    const file = join(out, "t.txt");
    const cases: Record<string, string[]> = {
      denied: [
        useLine("Edit", file, "d1"),
        resultLine("d1", { is_error: true, content: "Permission for this action was denied" }),
      ],
      failed: [useLine("Write", file, "e1"), resultLine("e1", { is_error: true })],
      "no result": [useLine("Write", file, "n1")],
      "result for another id": [useLine("Write", file, "a1"), resultLine("a2")],
      "result before its use": [resultLine("o1"), useLine("Write", file, "o1")],
      "result in a request copy": [
        useLine("Write", file, "b1"),
        JSON.stringify({
          type: "api-request-blob",
          message: { content: [{ type: "tool_result", tool_use_id: "b1" }] },
        }),
      ],
      "duplicate id": [
        useLine("Write", join(out, "sibling.txt"), "x1"),
        useLine("Write", file, "x1"),
        resultLine("x1"),
      ],
    };

    for (const [name, lines] of Object.entries(cases)) {
      const hono = app([], {}, lines);
      const listed = (await (await get(hono, `/${SID}/touched`)).json()) as { path: string; confirmed: boolean }[];
      expect({ name, listed: listed.find((item) => item.path === file)?.confirmed }).toEqual({
        name,
        listed: false,
      });
      const { file: response, download: reply } = await both(hono, helper(file));
      expect({ name, file: response.status, download: reply.status }).toEqual({ name, file: 404, download: 404 });
    }
  });

  test("a later failed call to a written path keeps it served", async () => {
    const file = join(out, "t.txt");
    const hono = app([file], {}, [useLine("Edit", file, "late"), resultLine("late", { is_error: true })]);
    const { file: response, download: reply, dBody } = await both(hono, helper(file));
    expect([response.status, reply.status, dBody]).toEqual([200, 200, "touched outside"]);
  });

  test("an abs under /proc, /sys or /dev is 404 even when written", async () => {
    const paths = [
      "/proc/version",
      "/proc/self/status",
      "/sys/kernel/mm/transparent_hugepage/enabled",
      "/dev/null",
      "/dev/zero",
    ].filter((path) => existsSync(path));
    expect(paths.length).toBeGreaterThan(1);
    const hono = app(paths);

    for (const path of paths) {
      const { file: response, download: reply } = await both(hono, helper(path));
      expect({ path: path, file: response.status, download: reply.status }).toEqual({
        path: path,
        file: 404,
        download: 404,
      });
    }
  });

  test("the touched answer leaves out /proc, /sys, /dev and state folder files, and keeps a normal outside file", async () => {
    const state = join(dir, "state");
    await mkdir(state);
    await writeFile(join(state, "key.pem"), "secret");
    await symlink(state, join(dir, "state-link"));
    const file = join(out, "t.txt");
    const listed = ["/proc/version", "/sys/kernel/x", "/dev/null", join(state, "key.pem"), file];

    for (const dirs of [[state], [join(dir, "state-link")]]) {
      const hono = app(listed, { refuseDirs: dirs });
      const touched = (await (await get(hono, `/${SID}/touched`)).json()) as { path: string }[];
      expect({ dirs, paths: touched.map((item) => item.path) }).toEqual({ dirs, paths: [file] });

      for (const item of listed.slice(0, 4)) {
        const { file: response, download: reply } = await both(hono, helper(item));
        expect({ path: item, file: response.status, download: reply.status }).toEqual({
          path: item,
          file: 404,
          download: 404,
        });
      }

      expect((await get(hono, `/${SID}/file?${helper(file)}`)).status).toBe(200);
    }
  });

  test("an abs inside a refused state folder is 404, also when the folder is reached through a link", async () => {
    const file = join(out, "t.txt");

    for (const dirs of [[out], [`${out}/`], [join(dir, "state-link")]]) {
      await rm(join(dir, "state-link"), { force: true });
      await symlink(out, join(dir, "state-link"));
      const { file: response, download: reply } = await both(app([file], { refuseDirs: dirs }), helper(file));
      expect({ dirs, file: response.status, download: reply.status }).toEqual({ dirs, file: 404, download: 404 });
    }

    expect(
      (await get(app([file], { refuseDirs: [join(dir, "missing")] }), `/${SID}/file?${helper(file)}`)).status,
    ).toBe(200);
  });

  test("an abs that has a second hard link is 404", async () => {
    const file = join(out, "t.txt");
    await link(file, join(out, "t2.txt"));
    const { file: response, download: reply } = await both(
      app([file, join(out, "t2.txt")]),
      helper(join(out, "t2.txt")),
    );
    expect([response.status, reply.status]).toEqual([404, 404]);
    expect((await get(app([file]), `/${SID}/file?${helper(file)}`)).status).toBe(404);
  });

  test("on Windows a UNC or device abs is 404 and never opened, a drive path matches without regard to case", async () => {
    const calls: [string, string][] = [];
    const previewIn = ((item: string, entry: string) =>
      Promise.resolve((calls.push([item, entry]), { name: entry, size: 0, kind: "text", text: "" }))) as never;
    const listed = [
      "\\\\srv\\share\\a.txt",
      "//srv/share/b.txt",
      "\\\\?\\C:\\c.txt",
      "\\\\.\\C:\\d.txt",
      "C:\\Users\\U\\T.txt",
    ];
    const hono = app(listed, { platform: "win32", previewIn });
    const touched = (await (await get(hono, `/${SID}/touched`)).json()) as { path: string }[];
    expect(touched.map((item) => item.path)).toEqual(["C:\\Users\\U\\T.txt"]);
    for (const item of listed.slice(0, 4))
      expect({ path: item, status: (await get(hono, `/${SID}/file?${helper(item)}`)).status }).toEqual({
        path: item,
        status: 404,
      });
    expect(calls).toEqual([]);
    expect((await get(hono, `/${SID}/file?${helper("c:\\users\\u\\t.TXT")}`)).status).toBe(200);
    expect(calls).toEqual([["C:\\Users\\U", "T.txt"]]);
  });

  test("touched and the abs gate read the transcript that rootOf found, without a second scan", async () => {
    let readdirs = 0;
    const fs = withTouched([join(out, "t.txt")]);
    const counted = { ...fs, readdir: async (path: string) => (readdirs++, fs.readdir(path)) };
    const hono = app([], { fs: counted });
    await get(hono, `/${SID}/files`);
    const one = readdirs;
    readdirs = 0;
    expect((await get(hono, `/${SID}/touched`)).status).toBe(200);
    expect(readdirs).toBe(one);
    readdirs = 0;
    expect((await get(hono, `/${SID}/file?${helper(join(out, "t.txt"))}`)).status).toBe(200);
    expect(readdirs).toBe(one);
  });

  test("a touched path inside the root is also served by abs", async () => {
    const response = await get(app([join(root, "a.txt")]), `/${SID}/file?${helper(join(root, "a.txt"))}`);
    expect(await response.json()).toMatchObject({ text: "hello" });
  });

  test("a path that is not on the touched list is 404 for preview and download", async () => {
    const hono = app([join(out, "t.txt")]);

    for (const item of [
      "/etc/hostname",
      "/etc/passwd",
      join(out, "sibling.txt"),
      out,
      join(out, "t.txt.bak"),
      join(root, "a.txt"),
      "/",
    ]) {
      const { file: response, download: reply, fBody, dBody } = await both(hono, helper(item));
      expect(response.status).toBe(404);
      expect(reply.status).toBe(404);
      expect(JSON.parse(fBody)).toEqual({ error: "file was not touched by this session" });
      expect(JSON.parse(dBody)).toEqual({ error: "file was not touched by this session" });
    }
  });

  test("the not-touched answer is the same for a file that exists and one that does not", async () => {
    const hono = app([join(out, "t.txt")]);
    const result = await both(hono, helper("/etc/hostname"));
    const fixture = await both(hono, helper("/nonexistent-dir-xyz/nope"));
    expect([result.file.status, result.download.status]).toEqual([fixture.file.status, fixture.download.status]);
    expect(result.fBody).toBe(fixture.fBody);
    expect(result.dBody).toBe(fixture.dBody);
    expect([...result.file.headers.entries()]).toEqual([...fixture.file.headers.entries()]);
  });

  test("an empty touched list serves nothing", async () => {
    const { file: response, download: reply } = await both(app([]), helper(join(out, "t.txt")));
    expect(response.status).toBe(404);
    expect(reply.status).toBe(404);
  });

  test("abs with .. segments is allowed only when it resolves exactly to a touched path", async () => {
    const hono = app([join(out, "t.txt")]);
    const ok = await get(hono, `/${SID}/download?${helper(`${out}/../outside/./t.txt`)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("touched outside");
    const ok2 = await get(hono, `/${SID}/file?${helper(`/${out}//t.txt`)}`);
    expect(ok2.status).toBe(200);
    await ok2.arrayBuffer();

    for (const path of [
      `${out}/../outside/sibling.txt`,
      `${out}/t.txt/../sibling.txt`,
      `${root}/../outside/sibling.txt`,
    ]) {
      const { file: response, download: reply } = await both(hono, helper(path));
      expect(response.status).toBe(404);
      expect(reply.status).toBe(404);
    }
  });

  test("encoding tricks do not reach an untouched file", async () => {
    const hono = app([join(out, "t.txt")]);

    // Double-encoded dots stay literal names.
    for (const query of [
      `abs=${encodeURIComponent(`${out}/%2e%2e/outside/sibling.txt`)}`,
      `abs=${out}/%252e%252e/sibling.txt`,
    ]) {
      const { file: response, download: reply } = await both(hono, query);
      expect(response.status).toBe(404);
      expect(reply.status).toBe(404);
    }

    // Case differs: a different file on Linux.
    if (process.platform === "linux") {
      const { file: response, download: reply } = await both(hono, helper(join(out, "T.txt")));
      expect(response.status).toBe(404);
      expect(reply.status).toBe(404);
    }
  });

  test("a repeated abs uses only the first value, which is checked", async () => {
    const hono = app([join(out, "t.txt")]);
    const response = await get(
      hono,
      `/${SID}/download?${helper(join(out, "sibling.txt"))}&${helper(join(out, "t.txt"))}`,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  test("a touched path whose final name is a symlink is refused, even to a sibling", async () => {
    await symlink(join(out, "sibling.txt"), join(out, "link-sib.txt"));
    await symlink("/etc/hostname", join(out, "link-etc.txt"));
    const hono = app([join(out, "link-sib.txt"), join(out, "link-etc.txt")]);

    for (const item of ["link-sib.txt", "link-etc.txt"]) {
      const { file: response, download: reply, fBody, dBody } = await both(hono, helper(join(out, item)));
      expect([403, 404]).toContain(response.status);
      expect([403, 404]).toContain(reply.status);
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
    const hono = app([join(linked, "t.txt")]);
    const { file: response, download: reply, fBody, dBody } = await both(hono, helper(join(linked, "t.txt")));
    expect([403, 404]).toContain(response.status);
    expect([403, 404]).toContain(reply.status);
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
    const hono = app([join(out, "t.txt")], {
      openDownload: (entry, rel, hooks) => mod.openDownload(entry, rel, { ...hooks, beforeOpen: swap }),
      previewIn: (entry, rel, hooks) => mod.previewIn(entry, rel, { ...hooks, beforeOpen: swap }),
    });
    const response = await get(hono, `/${SID}/download?${helper(join(out, "t.txt"))}`);
    expect([403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("secret");
    await restore();
    const reply = await get(hono, `/${SID}/file?${helper(join(out, "t.txt"))}`);
    expect([403, 404]).toContain(reply.status);
    expect(await reply.text()).not.toContain("secret");
    await restore();
  });

  test("a final name swapped for a symlink to a sibling between the check and the open is refused", async () => {
    const toLink = async (real: string) => {
      await rename(real, real + ".old");
      await symlink(join(out, "sibling.txt"), real);
    };

    const mod = await import("../src/sessionfs");
    const hono = app([join(out, "t.txt")], {
      openDownload: (item, rel, hooks) => mod.openDownload(item, rel, { ...hooks, beforeOpen: toLink }),
    });
    const response = await get(hono, `/${SID}/download?${helper(join(out, "t.txt"))}`);
    expect([403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("secret");
  });

  test("a touched path that was deleted, or whose folder is gone, is 404", async () => {
    const hono = app([join(out, "t.txt"), join(dir, "gone", "x.txt")]);
    await rm(join(out, "t.txt"));

    for (const item of [join(out, "t.txt"), join(dir, "gone", "x.txt")]) {
      const { file: response, download: reply } = await both(hono, helper(item));
      expect(response.status).toBe(404);
      expect(reply.status).toBe(404);
    }
  });

  test("a touched folder is not a file", async () => {
    const { file: response, download: reply } = await both(app([out]), helper(out));
    expect(response.status).toBe(400);
    expect(reply.status).toBe(400);
  });

  test("bad requests are 400: both, neither, relative, empty, NUL, control, too long", async () => {
    const hono = app([join(out, "t.txt")]);
    const bad = [
      `path=a.txt&${helper(join(out, "t.txt"))}`,
      `path=&${helper(join(out, "t.txt"))}`,
      "",
      "abs=",
      helper("outside/t.txt"),
      helper("../outside/t.txt"),
      helper(`${out}/t\u0000.txt`),
      helper(`${out}/t\n.txt`),
      helper("/" + "a".repeat(4096)),
    ];

    for (const query of bad) {
      const { file: response, download: reply } = await both(hono, query);
      expect([query, response.status]).toEqual([query, 400]);
      expect([query, reply.status]).toEqual([query, 400]);
    }
  });

  test("files (the folder browser) refuses abs with 400", async () => {
    const response = await get(app([out]), `/${SID}/files?${helper(out)}`);
    expect(response.status).toBe(400);
    await response.arrayBuffer();
  });
});
