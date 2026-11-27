import type { MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeApp } from "../src/app";
import type { Config } from "../src/config/parse";
import { encodeProjectDir } from "../src/sessions/transcript";

// The refusal rules have unit tests. This checks that the node app hands its real state folders to the abs gate.

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";
const ok = { authorization: "Bearer ok" };

const auth: MiddlewareHandler = async (context, next) => {
  if (context.req.header("authorization") !== "Bearer ok") return context.json({ error: "unauthorized" }, 401);
  context.set("caller" as never, "secret" as never);
  await next();
};

let dir: string;
let work: string;
let state: string;
let tlsState: string;
let outside: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wiring-")));
  work = join(dir, "work");
  state = join(dir, "state");
  tlsState = join(dir, "tls");
  outside = join(dir, "outside");
  for (const item of [work, state, tlsState, outside]) await mkdir(item);
  await writeFile(join(state, "hosts.json"), "state secret");
  await writeFile(join(tlsState, "node.key"), "tls secret");
  await writeFile(join(outside, "ok.txt"), "normal file");
  const home = join(dir, "home");
  const proj = join(home, ".claude", "projects", encodeProjectDir(work));
  await mkdir(proj, { recursive: true });
  const lines = [JSON.stringify({ type: "user", cwd: work, timestamp: "2026-11-11T10:00:00Z" })];

  for (const [item, entry] of [
    join(state, "hosts.json"),
    join(tlsState, "node.key"),
    join(outside, "ok.txt"),
  ].entries()) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-11T10:01:00Z",
        message: { content: [{ type: "tool_use", id: `toolu_${item}`, name: "Write", input: { file_path: entry } }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-11T10:01:01Z",
        message: { content: [{ type: "tool_result", tool_use_id: `toolu_${item}`, content: "ok" }] },
      }),
    );
  }

  await writeFile(join(proj, `${SID}.jsonl`), lines.join("\n") + "\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app() {
  const cfg = {
    mode: "node",
    name: "pi",
    roots: [dir],
    stateDir: state,
    node: { tls: { stateDir: tlsState } },
  } as unknown as Config;
  const instances: any = {
    list: () => Promise.resolve([]),
    // As root a write needs the owner (the service user), so the stub names this process as that user.
    claudeHome: (_id: string) =>
      Promise.resolve({
        path: work,
        home: join(dir, "home"),
        identity: { home: join(dir, "home"), path: "/usr/bin", uid: process.getuid?.(), gid: process.getgid?.() },
      }),
  };
  return createNodeApp({ cfg, instances, auth });
}

const both = async (abs: string) => {
  const item = `abs=${encodeURIComponent(abs)}`;
  const base = `/api/instances/${ID}/sessions/${SID}`;
  const hono = app();
  const response = await hono.request(`${base}/file?${item}`, { headers: ok });
  const reply = await hono.request(`${base}/download?${item}`, { headers: ok });
  // Read both bodies: a download stream that is never read keeps its file handle open.
  await response.arrayBuffer();
  await reply.arrayBuffer();
  return [response.status, reply.status];
};

describe("node app wiring of the refused state folders", () => {
  test("a touched, written file in the state folder is 404 for preview and download", async () => {
    expect(await both(join(state, "hosts.json"))).toEqual([404, 404]);
  });

  test("a touched, written file in the TLS state folder is 404 for preview and download", async () => {
    expect(await both(join(tlsState, "node.key"))).toEqual([404, 404]);
  });

  test("a touched, written file outside the state folders is served", async () => {
    expect(await both(join(outside, "ok.txt"))).toEqual([200, 200]);
  });

  test("the touched answer lists only the file outside the state folders", async () => {
    const response = await app().request(`/api/instances/${ID}/sessions/${SID}/touched`, { headers: ok });
    expect(((await response.json()) as { path: string }[]).map((item) => item.path)).toEqual([join(outside, "ok.txt")]);
  });
});

describe("permissions routes in the node app", () => {
  const base = `/api/instances/${ID}`;
  test("they need the node login", async () => {
    const hono = app();
    expect((await hono.request(`${base}/permissions`)).status).toBe(401);
    expect((await hono.request(`${base}/sessions/${SID}/permissions`)).status).toBe(401);
    expect((await hono.request(`${base}/sessions/${SID}/blocked`)).status).toBe(401);
  });
  test("the four edit routes need the node login and JSON, and answer for the real session folder", async () => {
    const hono = app();
    const urls = [`${base}/permissions/rules`, `${base}/sessions/${SID}/permissions/rules`];

    for (const url of urls) {
      for (const method of ["POST", "DELETE"]) {
        expect(
          (await hono.request(url, { method, headers: { "content-type": "application/json" }, body: "{}" })).status,
        ).toBe(401);
        expect(
          (await hono.request(url, { method, headers: { ...ok, "content-type": "text/plain" }, body: "{}" })).status,
        ).toBe(415);
      }
    }

    const body = JSON.stringify({ scope: "user", list: "allow", rule: "Bash(ls *)", expectedHash: null });
    const response = await hono.request(urls[1], {
      method: "POST",
      headers: { ...ok, "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(await readFile(join(dir, "home", ".claude", "settings.json"), "utf8")).permissions.allow).toEqual(
      ["Bash(ls *)"],
    );
  });
  test("the user, session and blocked routes answer for the real session folder", async () => {
    await mkdir(join(dir, "home", ".claude"), { recursive: true });
    await writeFile(
      join(dir, "home", ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls *)"] } }),
    );
    const hono = app();
    const user = (await (await hono.request(`${base}/permissions`, { headers: ok })).json()) as {
      layers: { scope: string; rules: { raw: string }[] }[];
    };
    expect(user.layers.map((layer) => layer.scope)).toEqual(["user"]);
    expect(user.layers[0].rules.map((rule) => rule.raw)).toEqual(["Bash(ls *)"]);
    const response = await hono.request(`${base}/sessions/${SID}/permissions`, { headers: ok });
    expect(response.status).toBe(200);
    const scopes = ((await response.json()) as { layers: { scope: string }[] }).layers.map((layer) => layer.scope);
    expect(scopes).toContain("project");
    expect(scopes.at(-1)).toBe("user");
    const reply = await hono.request(`${base}/sessions/${SID}/blocked`, { headers: ok });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual([]);
  });
});
