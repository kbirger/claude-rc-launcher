import { Hono } from "hono";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPOS_TIMEOUT_MS, UPDATE_TIMEOUT_MS } from "../src/hosts";
import { GITHUB_IDLE_TIMEOUT_SECONDS, UPDATE_IDLE_TIMEOUT_SECONDS, withLongUpdates } from "../src/serve";
import { ensureNodeCert } from "../src/tls";

// Bun checks idle requests on a coarse tick (about 4 s), so with idleTimeout 1 a request silent for 9 s is surely closed.
// TLS, as on a node: Bun 1.4.4 does not time out a plain-HTTP POST that has a body, but it does over TLS.
const SLOW_MS = 9_000;
const app = new Hono();

for (const item of ["/api/update", "/api/hosts/nas/update", "/cli/api/hosts/local/update", "/api/instances"]) {
  app.post(item, async (context) => (await Bun.sleep(SLOW_MS), context.json({ ok: true })));
}

// An event stream that is silent for longer than the idle limit, then sends its last chunk.
for (const item of ["/api/events", "/cli/api/events", "/api/hosts/nas/events"]) {
  app.get(
    item,
    () =>
      new Response(
        new ReadableStream({
          async start(ctl) {
            await Bun.sleep(SLOW_MS);
            ctl.enqueue(new TextEncoder().encode("late\n"));
            ctl.close();
          },
        }),
      ),
  );
}

const cert = await ensureNodeCert({ dir: mkdtempSync(path.join(os.tmpdir(), "rc-serve-")), names: ["localhost"] });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 1,
  tls: { cert: cert.certPem, key: cert.keyPem },
  fetch: withLongUpdates(app, 30),
});
afterAll(() => server.stop(true));
const post = (item: string) =>
  fetch(`https://localhost:${server.port}${item}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    tls: { ca: cert.certPem },
  } as RequestInit).then(
    (response) => response.status,
    (error: Error) => error.message,
  );

describe("withLongUpdates", () => {
  test("the update limit covers the hub's wait for a node and stays within Bun's maximum", () => {
    expect(UPDATE_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(UPDATE_TIMEOUT_MS);
    expect(UPDATE_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  test("a slow update request outlives the server idle limit; another slow request does not", async () => {
    const [node, hub, cli, other] = await Promise.all(
      ["/api/update", "/api/hosts/nas/update", "/cli/api/hosts/local/update", "/api/instances"].map(post),
    );
    expect([node, hub, cli]).toEqual([200, 200, 200]);
    expect(String(other)).toMatch(/ECONNRESET|closed/);
  }, 20_000);
});

describe("withLongUpdates: quiet event streams", () => {
  const get = (item: string) =>
    fetch(`https://localhost:${server.port}${item}`, { tls: { ca: cert.certPem } } as RequestInit).then(
      (response) => response.text(),
      (error: Error) => error.message,
    );
  test("a quiet stream on the node path and on the CLI path outlives the idle limit; another GET does not", async () => {
    const [node, cli, other] = await Promise.all(["/api/events", "/cli/api/events", "/api/hosts/nas/events"].map(get));
    expect([node, cli]).toEqual(["late\n", "late\n"]);
    expect(String(other)).toMatch(/ECONNRESET|closed|timed out/i);
  }, 20_000);
});

describe("withLongUpdates: GitHub routes", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const fetchApp = { fetch: () => new Response("ok") };

  const timeouts = async (method: string, item: string) => {
    const seen: [string, number][] = [];
    const server = { timeout: (req: Request, entry: number) => void seen.push([new URL(req.url).pathname, entry]) };
    await withLongUpdates(fetchApp, 190, 125)(new Request(`http://x${item}`, { method }), server as any);
    return seen;
  };

  test("the limit is above the repo-list wait and within Bun's maximum", () => {
    expect(GITHUB_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(REPOS_TIMEOUT_MS);
    expect(GITHUB_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  test("repo list (GET) and login start (POST) get the limit on node and hub paths", async () => {
    for (const item of ["/api/github/repos", "/api/hosts/nas/github/repos", "/cli/api/hosts/nas/github/repos"])
      expect([item, await timeouts("GET", item)]).toEqual([item, [[item, 125]]]);
    for (const item of ["/api/github/login", "/api/hosts/nas/github/login", "/cli/api/hosts/local/github/login"])
      expect([item, await timeouts("POST", item)]).toEqual([item, [[item, 125]]]);
  });

  test("other methods and paths are left alone, and update keeps its limit", async () => {
    for (const [item, entry] of [
      ["GET", `/api/github/login/${ID}`],
      ["GET", `/api/hosts/nas/github/login/${ID}`],
      ["POST", "/api/github/repos"],
      ["GET", "/api/github/login"],
      ["POST", "/api/clone"],
      ["GET", `/api/clone/${ID}`],
      ["POST", "/api/hosts/nas/clone"],
      ["GET", "/api/github/repos/x"],
      ["GET", "/api/hosts/a/b/github/repos"],
      ["GET", "/other/api/github/repos"],
    ])
      expect([item, entry, await timeouts(item, entry)]).toEqual([item, entry, []]);
    expect(await timeouts("POST", "/api/hosts/nas/update")).toEqual([["/api/hosts/nas/update", 190]]);
  });
});

describe("withLongUpdates: event stream", () => {
  const timeouts = async (method: string, item: string) => {
    const seen: [string, number][] = [];
    const server = { timeout: (req: Request, entry: number) => void seen.push([new URL(req.url).pathname, entry]) };
    await withLongUpdates(
      { fetch: () => new Response("ok") },
      190,
      125,
    )(new Request(`http://x${item}`, { method }), server as any);
    return seen;
  };

  test("GET /api/events and /cli/api/events turn the idle timeout off; other GET paths keep it", async () => {
    expect(await timeouts("GET", "/api/events")).toEqual([["/api/events", 0]]);
    expect(await timeouts("GET", "/cli/api/events")).toEqual([["/cli/api/events", 0]]);
    for (const item of [
      "/api/hosts",
      "/api/updates",
      "/api/hosts/nas/events",
      "/cli/api/events/x",
      "/x/cli/api/events",
    ])
      expect([item, await timeouts("GET", item)]).toEqual([item, []]);
    expect(await timeouts("POST", "/api/events")).toEqual([]);
  });
});

describe("withLongUpdates: instance settings routes", () => {
  const ID = "0123456789ab";

  const timeouts = async (method: string, item: string) => {
    const seen: [string, number][] = [];
    const server = { timeout: (req: Request, entry: number) => void seen.push([new URL(req.url).pathname, entry]) };
    await withLongUpdates(
      { fetch: () => new Response("ok") },
      190,
      125,
    )(new Request(`http://x${item}`, { method }), server as any);
    return seen;
  };

  test("PATCH and restart of an instance get the update limit on node and hub paths", async () => {
    for (const item of [`/api/instances/${ID}`, `/api/hosts/nas/instances/${ID}`, `/cli/api/hosts/nas/instances/${ID}`])
      expect([item, await timeouts("PATCH", item)]).toEqual([item, [[item, 190]]]);
    for (const item of [
      `/api/instances/${ID}/restart`,
      `/api/hosts/nas/instances/${ID}/restart`,
      `/cli/api/hosts/local/instances/${ID}/restart`,
    ])
      expect([item, await timeouts("POST", item)]).toEqual([item, [[item, 190]]]);
  });

  test("other methods, paths and ids are left alone", async () => {
    for (const [item, entry] of [
      ["GET", `/api/instances/${ID}`],
      ["POST", `/api/instances/${ID}`],
      ["DELETE", `/api/instances/${ID}`],
      ["GET", `/api/instances/${ID}/restart`],
      ["PATCH", `/api/instances/${ID}/restart`],
      ["GET", `/api/instances/${ID}/logs`],
      ["POST", `/api/instances/${ID}/pause`],
      ["PATCH", `/api/instances/${ID}/logs`],
      ["PATCH", "/api/instances/zz"],
      ["PATCH", "/api/instances/0123456789abc"],
      ["POST", "/api/instances/ABCDEF012345/restart"],
      ["POST", "/api/instances/zz/restart"],
      ["PATCH", `/api/hosts/a/b/instances/${ID}`],
      ["PATCH", `/other/api/instances/${ID}`],
    ])
      expect([item, entry, await timeouts(item, entry)]).toEqual([item, entry, []]);
  });
});
