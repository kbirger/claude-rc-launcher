import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onError } from "../src/app";
import { HttpError } from "../src/instances/InstanceService";
import type { Instances } from "../src/instances/InstanceService";
import type { nudge as nudgeFn } from "../src/nudge";
import { permissionsApi } from "../src/permissionsapi";
import { SessionCatalog } from "../src/sessioncatalog";
import type { TranscriptFs } from "../src/transcriptfs";
import { defined } from "./support";

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";

let dir: string;
let root: string;

/** A transcript store with one session per entry. `extra` lines follow the first record. */
function transcripts(sessions: Record<string, { cwd: string; extra?: string[] }>): TranscriptFs {
  const first = (cwd: string) =>
    JSON.stringify({ type: "user", cwd, timestamp: "2026-11-11T10:00:00Z", sessionId: "x" });
  return {
    readdir: () => Promise.resolve(Object.keys(sessions).map((key) => `${key}.jsonl`)),
    stat: () => Promise.resolve({ mtimeMs: 1000 }),
    lines: async function* (path: string) {
      const sid = defined(Object.keys(sessions).find((key) => path.endsWith(`${key}.jsonl`)));
      yield first(sessions[sid].cwd);
      for (const entry of sessions[sid].extra ?? []) yield entry;
    },
  };
}

const use = (id: string, command: string, at: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
const denied = (id: string, text: string) =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-11-14T10:00:09.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] },
  });

function build(
  options: {
    sessions?: Record<string, { cwd: string; extra?: string[] }>;
    home?: boolean;
    identity?: object;
    log?: (line: string) => void;
    isRoot?: () => boolean;
    nudge?: typeof nudgeFn;
  } = {},
) {
  const inst = {
    claudeHome: (id: string) => {
      if (id !== ID) return Promise.reject(new HttpError(404, "instance not found"));
      return Promise.resolve({ path: root, home: dir, ...(options.identity ? { identity: options.identity } : {}) });
    },
  } as unknown as Instances;
  if (options.home === false) delete (inst as { claudeHome?: unknown }).claudeHome;
  const sessions = new SessionCatalog({
    fs: transcripts(options.sessions ?? { [SID]: { cwd: root } }),
    platform: "darwin",
  });
  const app = new Hono();
  app.route(
    "/instances/:id",
    permissionsApi({
      instances: inst,
      sessions,
      ...(options.log ? { log: options.log } : {}),
      isRoot: options.isRoot ?? (() => false),
      ...(options.nudge ? { nudge: options.nudge } : {}),
    }),
  );
  app.onError(onError);
  return app;
}

const get = (app: Hono, item: string) => app.request(`/instances/${ID}${item}`);

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
    const response = await get(build(), "/permissions");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { layers: { scope: string; state: string; rules: { raw: string }[] }[] };
    expect(body.layers.map((layer) => layer.scope)).toEqual(["user"]);
    expect(body.layers[0].state).toBe("ok");
    expect(body.layers[0].rules.map((rule) => rule.raw)).toEqual(["Bash(ls *)", "Bash(rm *)"]);
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
    const response = await get(build(), `/sessions/${SID}/permissions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      layers: { scope: string; rules: { raw: string; shadowedBy?: { scope: string } }[] }[];
    };
    expect(body.layers.map((layer) => layer.scope)).toEqual(["local", "project", "user"]);
    expect(body.layers[0].rules[0].shadowedBy).toMatchObject({ scope: "user", list: "deny", raw: "Bash(rm *)" });
  });
  test("a bad session id is 400, an unknown session is 404", async () => {
    expect((await get(build(), "/sessions/nope/permissions")).status).toBe(400);
    expect((await get(build(), "/sessions/11111111-2222-3333-4444-666666666666/permissions")).status).toBe(404);
  });
  test("a session folder outside the instance folder is 404", async () => {
    const outside = await mkdtemp(join(tmpdir(), "papi-out-"));

    try {
      const response = await get(build({ sessions: { [SID]: { cwd: outside } } }), `/sessions/${SID}/permissions`);
      expect(response.status).toBe(404);
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
      denied(
        "t2",
        "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Modify Shared Resource].",
      ),
      use("t3", "false", "2026-11-14T10:00:07.000Z"),
      denied("t3", "Exit code 1"),
    ];
    const response = await get(build({ sessions: { [SID]: { cwd: root, extra } } }), `/sessions/${SID}/blocked`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; reason: string }[];
    expect(body.map((item) => [item.id, item.reason])).toEqual([
      ["t2", "classifier"],
      ["t1", "needs_approval"],
    ]);
  });
  test("a session that does not exist is 404 and a bad id is 400", async () => {
    expect((await get(build(), "/sessions/11111111-2222-3333-4444-666666666666/blocked")).status).toBe(404);
    expect((await get(build(), "/sessions/nope/blocked")).status).toBe(400);
  });
});

const send = (app: Hono, method: string, item: string, body: unknown) =>
  app.request(`/instances/${ID}${item}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const userFile = () => join(dir, ".claude", "settings.json");
const hashOf = async (app: Hono, item: string, scope: string) =>
  ((await (await get(app, item)).json()) as { layers: { scope: string; hash?: string }[] }).layers.find(
    (layer) => layer.scope === scope,
  )?.hash ?? null;

describe("rule edit routes", () => {
  test("an add through the user route reads back, and a remove takes it out", async () => {
    const app = build();
    const response = await send(app, "POST", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(git *)",
      expectedHash: await hashOf(app, "/permissions", "user"),
    });
    expect(response.status).toBe(200);
    const layer = (await response.json()) as { scope: string; rules: { raw: string }[]; hash: string };
    expect(layer.scope).toBe("user");
    expect(layer.rules.map((rule) => rule.raw)).toContain("Bash(git *)");
    expect(JSON.parse(await readFile(userFile(), "utf8")).permissions.allow).toContain("Bash(git *)");
    const reply = await send(app, "DELETE", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(git *)",
      expectedHash: layer.hash,
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(await readFile(userFile(), "utf8")).permissions.allow).not.toContain("Bash(git *)");
  });
  test("the user route takes only scope user", async () => {
    const app = build();
    expect(
      (
        await send(app, "POST", "/permissions/rules", {
          scope: "local",
          list: "allow",
          rule: "Bash",
          expectedHash: null,
        })
      ).status,
    ).toBe(400);
  });
  test("an add through the session route to local writes at the git root path", async () => {
    const app = build();
    const item = `/sessions/${SID}/permissions/rules`;
    const response = await send(app, "POST", item, {
      scope: "local",
      list: "deny",
      rule: "Bash(curl *)",
      expectedHash: await hashOf(app, `/sessions/${SID}/permissions`, "local"),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(await readFile(join(root, ".claude", "settings.local.json"), "utf8")).permissions.deny).toEqual([
      "Bash(curl *)",
    ]);
    const user = await send(app, "POST", item, {
      scope: "user",
      list: "ask",
      rule: "Edit",
      expectedHash: await hashOf(app, `/sessions/${SID}/permissions`, "user"),
    });
    expect(user.status).toBe(200);
  });
  test("scope managed and legacy-local are 403, a bad scope or list is 400", async () => {
    const app = build();
    const item = `/sessions/${SID}/permissions/rules`;
    expect(
      (await send(app, "POST", item, { scope: "managed", list: "allow", rule: "Bash", expectedHash: null })).status,
    ).toBe(403);
    expect(
      (await send(app, "POST", item, { scope: "legacy-local", list: "allow", rule: "Bash", expectedHash: null }))
        .status,
    ).toBe(403);
    expect(
      (await send(app, "POST", item, { scope: "nope", list: "allow", rule: "Bash", expectedHash: null })).status,
    ).toBe(400);
    expect(
      (await send(app, "POST", item, { scope: "local", list: "nope", rule: "Bash", expectedHash: null })).status,
    ).toBe(400);
    expect((await send(app, "POST", item, { scope: "local", list: "allow", rule: 5, expectedHash: null })).status).toBe(
      400,
    );
    expect(
      (await send(app, "POST", item, { scope: "local", list: "allow", rule: "Bash", expectedHash: 5 })).status,
    ).toBe(400);
  });
  test("a stale hash is 409 and the file stays unchanged", async () => {
    const app = build();
    const before = await readFile(userFile(), "utf8");
    const response = await send(app, "POST", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(git *)",
      expectedHash: "0".repeat(64),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBeString();
    expect(await readFile(userFile(), "utf8")).toBe(before);
  });
  test("a session outside the instance is 404", async () => {
    const outside = await mkdtemp(join(tmpdir(), "papi-out-"));

    try {
      const app = build({ sessions: { [SID]: { cwd: outside } } });
      expect(
        (
          await send(app, "POST", `/sessions/${SID}/permissions/rules`, {
            scope: "user",
            list: "allow",
            rule: "Bash",
            expectedHash: null,
          })
        ).status,
      ).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  test("the audit line has the rule and no file content, and a newline in a rule cannot forge a line", async () => {
    const lines: string[] = [];
    const app = build({ log: (line) => lines.push(line) });
    await send(app, "POST", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(git *)",
      expectedHash: await hashOf(app, "/permissions", "user"),
    });
    await send(app, "POST", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(a\nb)",
      expectedHash: null,
    });
    expect(lines[0]).toBe(
      `audit caller=unknown instance=${ID} scope=user action=add list=allow rule="Bash(git *)" status=200 nudge=off`,
    );
    expect(lines.join("\n")).not.toContain("Bash(rm *)");
    const bad = await send(app, "POST", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(a\nb)",
      expectedHash: null,
    });
    expect(bad.status).toBe(400);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(lines.at(-1)).toContain('rule="Bash(a\\nb)"');
    expect(lines.at(-1)).toContain("status=400");
  });
  test("a hostile scope, list or instance cannot forge a line or a field", async () => {
    const lines: string[] = [];
    const app = build({ log: (line) => lines.push(line) });
    const evil = "user\naudit caller=x instance=0123456789ab status=200 rule=a";
    expect(
      (await send(app, "POST", "/permissions/rules", { scope: evil, list: evil, rule: "Bash", expectedHash: null }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(app, "POST", "/permissions/rules", {
          scope: "user x=1",
          list: "allow z=2",
          rule: "Bash",
          expectedHash: null,
        })
      ).status,
    ).toBe(400);
    expect(lines.length).toBe(2);

    for (const line of lines) {
      expect(line).toBe(
        `audit caller=unknown instance=${ID} scope=? action=add list=? rule="Bash" status=400 nudge=off`,
      );
    }
  });
});

describe("a root node and the default user", () => {
  const me = defined(process.getuid)();
  const gid = defined(process.getgid)();
  const base = { home: "/x", path: "/usr/bin" };
  const rule = (scope: string, expectedHash: string | null) => ({
    scope,
    list: "allow",
    rule: "Bash(git *)",
    expectedHash,
  });

  test("an identity with no uid is refused with 403 and the file is not touched (user route)", async () => {
    const app = build({ identity: base, isRoot: () => true });
    const before = await readFile(userFile(), "utf8");
    const response = await send(
      app,
      "POST",
      "/permissions/rules",
      rule("user", await hashOf(app, "/permissions", "user")),
    );
    expect(response.status).toBe(403);
    expect(await readFile(userFile(), "utf8")).toBe(before);
  });
  test("an identity with no uid makes no .claude folder (session route, new project file)", async () => {
    const app = build({ identity: base, isRoot: () => true });
    const response = await send(app, "POST", `/sessions/${SID}/permissions/rules`, rule("project", null));
    expect(response.status).toBe(403);
    expect(await stat(join(root, ".claude", "settings.json")).catch(() => null)).toBeNull();
  });
  test("an identity with a uid and gid writes, and the file keeps the owner", async () => {
    const app = build({ identity: { ...base, uid: me, gid }, isRoot: () => true });
    const response = await send(
      app,
      "POST",
      "/permissions/rules",
      rule("user", await hashOf(app, "/permissions", "user")),
    );
    expect(response.status).toBe(200);
    expect((await stat(userFile())).uid).toBe(me);
  });
  test("the real files of the service user still read with its uid in the identity", async () => {
    const app = build({ identity: { ...base, uid: me, gid }, isRoot: () => true });
    const body = (await (await get(app, "/permissions")).json()) as { layers: { state: string }[] };
    expect(body.layers[0].state).toBe("ok");
    const harness = (await (await get(app, `/sessions/${SID}/permissions`)).json()) as {
      layers: { scope: string; state: string }[];
    };
    expect(harness.layers.filter((layer) => layer.scope !== "project").map((layer) => layer.state)).toEqual([
      "ok",
      "ok",
    ]);
  });
});

describe("the nudge flag", () => {
  const item = `/sessions/${SID}/permissions/rules`;
  const SECRET = "/run/secret-sock-path-xyz";
  const edit = async (app: Hono, extra: object = {}, scope = "user") => ({
    scope,
    list: "allow",
    rule: "Bash(git *)",
    expectedHash: await hashOf(app, `/sessions/${SID}/permissions`, scope),
    ...extra,
  });

  const fake = () => {
    const calls: any[] = [];
    const fn = ((entry: any) => Promise.resolve((calls.push(entry), { sent: true }))) as unknown as typeof nudgeFn;
    return { calls, fn };
  };

  test("add with nudge true calls nudge after the write and returns it under the nudge key", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    const response = await send(app, "POST", item, await edit(app, { nudge: true }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rules: unknown[]; nudge: unknown };
    expect(body.nudge).toEqual({ sent: true });
    expect(body.rules).toBeArray();
    expect(harness.calls.length).toBe(1);
    expect(JSON.parse(await readFile(userFile(), "utf8")).permissions.allow).toContain("Bash(git *)");
    expect(harness.calls[0].sessionId).toBe(SID);
    expect(harness.calls[0].home).toBe(dir);
  });
  test("an add without the flag, or with false, has no nudge key and never calls nudge", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    const response = await send(app, "POST", item, await edit(app));
    expect("nudge" in ((await response.json()) as object)).toBe(false);
    const reply = await send(app, "POST", item, await edit(app, { rule: "Bash(ls)", nudge: false }));
    expect("nudge" in ((await reply.json()) as object)).toBe(false);
    expect(harness.calls).toEqual([]);
  });
  test("the nudge message holds the list and the quoted file path and never the rule", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    await send(app, "POST", item, await edit(app, { nudge: true, rule: "Bash(zzmarker9 *)" }));
    const entry = harness.calls[0].message as string;
    expect(entry).not.toContain("zzmarker9");
    expect(entry).toContain("allow list");
    expect(entry).toContain(JSON.stringify(userFile()));
  });
  test("nudge true with a list other than allow gives 400 and never calls nudge", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });

    for (const list of ["ask", "deny"]) {
      const response = await send(app, "POST", item, await edit(app, { nudge: true, list }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("nudge needs the allow list");
    }

    expect(harness.calls).toEqual([]);
  });
  test("a 409 add with nudge true never calls nudge", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    const response = await send(app, "POST", item, await edit(app, { nudge: true, expectedHash: "0".repeat(64) }));
    expect(response.status).toBe(409);
    expect("nudge" in ((await response.json()) as object)).toBe(false);
    expect(harness.calls).toEqual([]);
  });
  test("a 400 add never calls nudge", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    expect((await send(app, "POST", item, await edit(app, { nudge: true, list: "nope" }))).status).toBe(400);
    expect(harness.calls).toEqual([]);
  });
  test("a remove with nudge true gives 400 and never calls nudge", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    const response = await send(app, "DELETE", item, {
      scope: "user",
      list: "allow",
      rule: "Bash(ls *)",
      expectedHash: await hashOf(app, `/sessions/${SID}/permissions`, "user"),
      nudge: true,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("nudge is not for a remove");
    expect(harness.calls).toEqual([]);
  });
  test("the user route refuses nudge true with 400", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    const response = await send(app, "POST", "/permissions/rules", {
      scope: "user",
      list: "allow",
      rule: "Bash(git *)",
      expectedHash: null,
      nudge: true,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("nudge needs a session");
    expect(harness.calls).toEqual([]);
  });
  test("nudge with a non boolean value gives 400", async () => {
    const harness = fake();
    const app = build({ nudge: harness.fn });
    for (const value of ["true", 1, null, {}])
      expect((await send(app, "POST", item, await edit(app, { nudge: value }))).status).toBe(400);
    expect(harness.calls).toEqual([]);
  });
  test("a throw inside nudge is send_failed and the add stays 200", async () => {
    const lines: string[] = [];
    const app = build({
      log: (line) => lines.push(line),
      nudge: (() => {
        return Promise.reject(new Error(SECRET));
      }) as unknown as typeof nudgeFn,
    });
    const response = await send(app, "POST", item, await edit(app, { nudge: true }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { nudge: unknown }).nudge).toEqual({ sent: false, reason: "send_failed" });
    expect(lines[0]).toEndWith("status=200 nudge=send_failed");
    expect(lines.join("\n")).not.toContain(SECRET);
  });
  test("the answer and the audit line hold no socket path", async () => {
    const lines: string[] = [];
    // The real nudge runs, with a fake find and a fake send. A fake send that fails would leak a path only if the code did.
    const { nudge } = await import("../src/nudge");
    const fn = ((entry: any) =>
      nudge({
        ...entry,
        platform: "linux",
        isRoot: () => false,
        find: () => Promise.resolve(SECRET),
        send: async () => {},
      })) as typeof nudgeFn;
    const app = build({ log: (line) => lines.push(line), nudge: fn });
    const response = await send(app, "POST", item, await edit(app, { nudge: true }));
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
  test("audit line ends with nudge=sent", async () => {
    const lines: string[] = [];
    const app = build({ log: (line) => lines.push(line), nudge: fake().fn });
    await send(app, "POST", item, await edit(app, { nudge: true }));
    expect(lines[0]).toEndWith(" status=200 nudge=sent");
  });
  test("audit line ends with nudge=off for a failed add", async () => {
    const lines: string[] = [];
    const app = build({ log: (line) => lines.push(line), nudge: fake().fn });
    await send(app, "POST", item, await edit(app, { nudge: true, expectedHash: "0".repeat(64) }));
    expect(lines[0]).toEndWith(" status=409 nudge=off");
  });
  test("audit line carries the reason when the session is not live", async () => {
    const lines: string[] = [];
    const app = build({
      log: (line) => lines.push(line),
      nudge: (() => Promise.resolve({ sent: false, reason: "not_live" })) as unknown as typeof nudgeFn,
    });
    await send(app, "POST", item, await edit(app, { nudge: true }));
    expect(lines[0]).toEndWith(" nudge=not_live");
  });
});
