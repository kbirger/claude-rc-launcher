import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { onError } from "../src/app";
import { HttpError, type Instances } from "../src/instances";
import { permissionsApi } from "../src/permissionsapi";
import { SessionCatalog } from "../src/sessioncatalog";
import type { TranscriptFs } from "../src/transcriptfs";

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";

let dir: string;
let root: string;

/** A transcript store with one session per entry. `extra` lines follow the first record. */
function transcripts(sessions: Record<string, { cwd: string; extra?: string[] }>): TranscriptFs {
  const first = (cwd: string) => JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T10:00:00Z", sessionId: "x" });
  return {
    readdir: async () => Object.keys(sessions).map((s) => `${s}.jsonl`),
    stat: async () => ({ mtimeMs: 1000 }),
    lines: async function* (p: string) {
      const sid = Object.keys(sessions).find((s) => p.endsWith(`${s}.jsonl`))!;
      yield first(sessions[sid]!.cwd);
      for (const l of sessions[sid]!.extra ?? []) yield l;
    },
  };
}

const use = (id: string, command: string, at: string) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const denied = (id: string, text: string) =>
  JSON.stringify({ type: "user", timestamp: "2026-11-14T10:00:09.000Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] } });

function build(o: { sessions?: Record<string, { cwd: string; extra?: string[] }>; home?: boolean; identity?: object } = {}) {
  const inst = {
    claudeHome: async (id: string) => {
      if (id !== ID) throw new HttpError(404, "instance not found");
      return { path: root, home: dir, ...(o.identity ? { identity: o.identity } : {}) };
    },
  } as unknown as Instances;
  if (o.home === false) delete (inst as { claudeHome?: unknown }).claudeHome;
  const sessions = new SessionCatalog({ fs: transcripts(o.sessions ?? { [SID]: { cwd: root } }), platform: "darwin" });
  const app = new Hono();
  app.route("/instances/:id", permissionsApi({ instances: inst, sessions }));
  app.onError(onError);
  return app;
}
const get = (app: Hono, p: string) => app.request(`/instances/${ID}${p}`);

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "papi-"));
  root = join(dir, "work");
  await mkdir(join(root, ".git"), { recursive: true });
  await put(join(dir, ".claude", "settings.json"), { permissions: { allow: ["Bash(ls *)"], deny: ["Bash(rm *)"] } });
  await put(join(root, ".claude", "settings.local.json"), { permissions: { allow: ["Bash(rm *)"] } });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("GET /instances/:id/permissions (the user file)", () => {
  test("answers only the user layer with its rules", async () => {
    const r = await get(build(), "/permissions");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { layers: { scope: string; state: string; rules: { raw: string }[] }[] };
    expect(body.layers.map((l) => l.scope)).toEqual(["user"]);
    expect(body.layers[0]!.state).toBe("ok");
    expect(body.layers[0]!.rules.map((x) => x.raw)).toEqual(["Bash(ls *)", "Bash(rm *)"]);
  });
  test("a bad instance id is 400, an unknown instance is 404", async () => {
    expect((await build().request("/instances/zz/permissions")).status).toBe(400);
    expect((await build().request("/instances/aaaaaaaaaaaa/permissions")).status).toBe(404);
  });
  test("a host without session support is 501", async () => {
    expect((await get(build({ home: false }), "/permissions")).status).toBe(501);
  });
});

describe("GET /instances/:id/sessions/:sid/permissions", () => {
  test("answers every layer in precedence order, with shadowed rules marked", async () => {
    const r = await get(build(), `/sessions/${SID}/permissions`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { layers: { scope: string; rules: { raw: string; shadowedBy?: { scope: string } }[] }[] };
    expect(body.layers.map((l) => l.scope)).toEqual(["local", "project", "user"]);
    expect(body.layers[0]!.rules[0]!.shadowedBy).toMatchObject({ scope: "user", list: "deny", raw: "Bash(rm *)" });
  });
  test("a bad session id is 400, an unknown session is 404", async () => {
    expect((await get(build(), "/sessions/nope/permissions")).status).toBe(400);
    expect((await get(build(), "/sessions/11111111-2222-3333-4444-666666666666/permissions")).status).toBe(404);
  });
  test("a session folder outside the instance folder is 404", async () => {
    const outside = await mkdtemp(join(tmpdir(), "papi-out-"));
    try {
      const r = await get(build({ sessions: { [SID]: { cwd: outside } } }), `/sessions/${SID}/permissions`);
      expect(r.status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("GET /instances/:id/sessions/:sid/blocked", () => {
  test("answers the blocked calls of the transcript, newest first", async () => {
    const extra = [
      use("t1", "touch a", "2026-11-14T10:00:00.000Z"),
      denied("t1", "touch in '/x/a' needs approval."),
      use("t2", "git push", "2026-11-14T10:00:05.000Z"),
      denied("t2", "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Modify Shared Resource]."),
      use("t3", "false", "2026-11-14T10:00:07.000Z"),
      denied("t3", "Exit code 1"),
    ];
    const r = await get(build({ sessions: { [SID]: { cwd: root, extra } } }), `/sessions/${SID}/blocked`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string; reason: string }[];
    expect(body.map((b) => [b.id, b.reason])).toEqual([
      ["t2", "classifier"],
      ["t1", "needs_approval"],
    ]);
  });
  test("a session that does not exist is 404 and a bad id is 400", async () => {
    expect((await get(build(), "/sessions/11111111-2222-3333-4444-666666666666/blocked")).status).toBe(404);
    expect((await get(build(), "/sessions/nope/blocked")).status).toBe(400);
  });
});
