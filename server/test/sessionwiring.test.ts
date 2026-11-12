import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { createNodeApp } from "../src/app";
import type { Config } from "../src/config";
import { encodeProjectDir } from "../src/transcript";

// The refusal rules have unit tests. This checks that the node app hands its real state folders to the abs gate.

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";
const ok = { authorization: "Bearer ok" };
const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== "Bearer ok") return c.json({ error: "unauthorized" }, 401);
  c.set("caller" as never, "secret" as never);
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
  for (const d of [work, state, tlsState, outside]) await mkdir(d);
  await writeFile(join(state, "hosts.json"), "state secret");
  await writeFile(join(tlsState, "node.key"), "tls secret");
  await writeFile(join(outside, "ok.txt"), "normal file");
  const home = join(dir, "home");
  const proj = join(home, ".claude", "projects", encodeProjectDir(work));
  await mkdir(proj, { recursive: true });
  const lines = [JSON.stringify({ type: "user", cwd: work, timestamp: "2026-11-11T10:00:00Z" })];
  for (const [i, p] of [join(state, "hosts.json"), join(tlsState, "node.key"), join(outside, "ok.txt")].entries()) {
    lines.push(JSON.stringify({ type: "assistant", timestamp: "2026-11-11T10:01:00Z", message: { content: [{ type: "tool_use", id: `toolu_${i}`, name: "Write", input: { file_path: p } }] } }));
    lines.push(JSON.stringify({ type: "user", timestamp: "2026-11-11T10:01:01Z", message: { content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "ok" }] } }));
  }
  await writeFile(join(proj, `${SID}.jsonl`), lines.join("\n") + "\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app() {
  const cfg = { mode: "node", name: "pi", roots: [dir], stateDir: state, node: { tls: { stateDir: tlsState } } } as unknown as Config;
  const instances: any = {
    list: async () => [],
    claudeHome: async (id: string) => ({ path: work, home: join(dir, "home") }),
  };
  return createNodeApp({ cfg, instances, auth });
}
const both = async (abs: string) => {
  const q = `abs=${encodeURIComponent(abs)}`;
  const base = `/api/instances/${ID}/sessions/${SID}`;
  const a = app();
  const f = await a.request(`${base}/file?${q}`, { headers: ok });
  const d = await a.request(`${base}/download?${q}`, { headers: ok });
  // Read both bodies: a download stream that is never read keeps its file handle open.
  await f.arrayBuffer();
  await d.arrayBuffer();
  return [f.status, d.status];
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
    const r = await app().request(`/api/instances/${ID}/sessions/${SID}/touched`, { headers: ok });
    expect(((await r.json()) as { path: string }[]).map((t) => t.path)).toEqual([join(outside, "ok.txt")]);
  });
});
