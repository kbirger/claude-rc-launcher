import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function build(o: { sessions?: Record<string, { cwd: string; extra?: string[] }>; home?: boolean; identity?: object; log?: (l: string) => void } = {}) {
  const inst = {
    claudeHome: async (id: string) => {
      if (id !== ID) throw new HttpError(404, "instance not found");
      return { path: root, home: dir, ...(o.identity ? { identity: o.identity } : {}) };
    },
  } as unknown as Instances;
  if (o.home === false) delete (inst as { claudeHome?: unknown }).claudeHome;
  const sessions = new SessionCatalog({ fs: transcripts(o.sessions ?? { [SID]: { cwd: root } }), platform: "darwin" });
  const app = new Hono();
  app.route("/instances/:id", permissionsApi({ instances: inst, sessions, ...(o.log ? { log: o.log } : {}) }));
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

const send = (app: Hono, method: string, p: string, body: unknown) =>
  app.request(`/instances/${ID}${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const userFile = () => join(dir, ".claude", "settings.json");
const hashOf = async (app: Hono, p: string, scope: string) =>
  ((await (await get(app, p)).json()) as { layers: { scope: string; hash?: string }[] }).layers.find((l) => l.scope === scope)?.hash ?? null;

describe("rule edit routes", () => {
  test("an add through the user route reads back, and a remove takes it out", async () => {
    const app = build();
    const r = await send(app, "POST", "/permissions/rules", { scope: "user", list: "allow", rule: "Bash(git *)", expectedHash: await hashOf(app, "/permissions", "user") });
    expect(r.status).toBe(200);
    const layer = (await r.json()) as { scope: string; rules: { raw: string }[]; hash: string };
    expect(layer.scope).toBe("user");
    expect(layer.rules.map((x) => x.raw)).toContain("Bash(git *)");
    expect(JSON.parse(await readFile(userFile(), "utf8")).permissions.allow).toContain("Bash(git *)");
    const d = await send(app, "DELETE", "/permissions/rules", { scope: "user", list: "allow", rule: "Bash(git *)", expectedHash: layer.hash });
    expect(d.status).toBe(200);
    expect(JSON.parse(await readFile(userFile(), "utf8")).permissions.allow).not.toContain("Bash(git *)");
  });
  test("the user route takes only scope user", async () => {
    const app = build();
    expect((await send(app, "POST", "/permissions/rules", { scope: "local", list: "allow", rule: "Bash", expectedHash: null })).status).toBe(400);
  });
  test("an add through the session route to local writes at the git root path", async () => {
    const app = build();
    const p = `/sessions/${SID}/permissions/rules`;
    const r = await send(app, "POST", p, { scope: "local", list: "deny", rule: "Bash(curl *)", expectedHash: await hashOf(app, `/sessions/${SID}/permissions`, "local") });
    expect(r.status).toBe(200);
    expect(JSON.parse(await readFile(join(root, ".claude", "settings.local.json"), "utf8")).permissions.deny).toEqual(["Bash(curl *)"]);
    const user = await send(app, "POST", p, { scope: "user", list: "ask", rule: "Edit", expectedHash: await hashOf(app, `/sessions/${SID}/permissions`, "user") });
    expect(user.status).toBe(200);
  });
  test("scope managed and legacy-local are 403, a bad scope or list is 400", async () => {
    const app = build();
    const p = `/sessions/${SID}/permissions/rules`;
    expect((await send(app, "POST", p, { scope: "managed", list: "allow", rule: "Bash", expectedHash: null })).status).toBe(403);
    expect((await send(app, "POST", p, { scope: "legacy-local", list: "allow", rule: "Bash", expectedHash: null })).status).toBe(403);
    expect((await send(app, "POST", p, { scope: "nope", list: "allow", rule: "Bash", expectedHash: null })).status).toBe(400);
    expect((await send(app, "POST", p, { scope: "local", list: "nope", rule: "Bash", expectedHash: null })).status).toBe(400);
    expect((await send(app, "POST", p, { scope: "local", list: "allow", rule: 5, expectedHash: null })).status).toBe(400);
    expect((await send(app, "POST", p, { scope: "local", list: "allow", rule: "Bash", expectedHash: 5 })).status).toBe(400);
  });
  test("a stale hash is 409 and the file stays unchanged", async () => {
    const app = build();
    const before = await readFile(userFile(), "utf8");
    const r = await send(app, "POST", "/permissions/rules", { scope: "user", list: "allow", rule: "Bash(git *)", expectedHash: "0".repeat(64) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBeString();
    expect(await readFile(userFile(), "utf8")).toBe(before);
  });
  test("a session outside the instance is 404", async () => {
    const outside = await mkdtemp(join(tmpdir(), "papi-out-"));
    try {
      const app = build({ sessions: { [SID]: { cwd: outside } } });
      expect((await send(app, "POST", `/sessions/${SID}/permissions/rules`, { scope: "user", list: "allow", rule: "Bash", expectedHash: null })).status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  test("the audit line has the rule and no file content, and a newline in a rule cannot forge a line", async () => {
    const lines: string[] = [];
    const app = build({ log: (l) => lines.push(l) });
    await send(app, "POST", "/permissions/rules", { scope: "user", list: "allow", rule: "Bash(git *)", expectedHash: await hashOf(app, "/permissions", "user") });
    await send(app, "POST", "/permissions/rules", { scope: "user", list: "allow", rule: "Bash(a\nb)", expectedHash: null });
    expect(lines[0]).toBe(`audit caller=unknown instance=${ID} scope=user action=add list=allow rule="Bash(git *)" status=200`);
    expect(lines.join("\n")).not.toContain("Bash(rm *)");
    const bad = await send(app, "POST", "/permissions/rules", { scope: "user", list: "allow", rule: "Bash(a\nb)", expectedHash: null });
    expect(bad.status).toBe(400);
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
    expect(lines.at(-1)).toContain('rule="Bash(a\\nb)"');
    expect(lines.at(-1)).toContain("status=400");
  });
  test("a hostile scope, list or instance cannot forge a line or a field", async () => {
    const lines: string[] = [];
    const app = build({ log: (l) => lines.push(l) });
    const evil = "user\naudit caller=x instance=0123456789ab status=200 rule=a";
    expect((await send(app, "POST", "/permissions/rules", { scope: evil, list: evil, rule: "Bash", expectedHash: null })).status).toBe(400);
    expect((await send(app, "POST", "/permissions/rules", { scope: "user x=1", list: "allow z=2", rule: "Bash", expectedHash: null })).status).toBe(400);
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l).toBe(`audit caller=unknown instance=${ID} scope=? action=add list=? rule="Bash" status=400`);
    }
  });
});
