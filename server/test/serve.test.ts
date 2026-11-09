import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { GITHUB_IDLE_TIMEOUT_SECONDS, UPDATE_IDLE_TIMEOUT_SECONDS, withLongUpdates } from "../src/serve";
import { REPOS_TIMEOUT_MS, UPDATE_TIMEOUT_MS } from "../src/hosts";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureNodeCert } from "../src/tls";

// Bun checks idle requests on a coarse tick (about 4 s), so with idleTimeout 1 a request silent for 9 s is surely closed.
// TLS, as on a node: Bun 1.4.4 does not time out a plain-HTTP POST that has a body, but it does over TLS.
const SLOW_MS = 9_000;
const app = new Hono();
for (const p of ["/api/update", "/api/hosts/nas/update", "/cli/api/hosts/local/update", "/api/instances"]) {
  app.post(p, async (c) => (await Bun.sleep(SLOW_MS), c.json({ ok: true })));
}
const cert = await ensureNodeCert({ dir: mkdtempSync(path.join(os.tmpdir(), "rc-serve-")), names: ["localhost"] });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 1, tls: { cert: cert.certPem, key: cert.keyPem }, fetch: withLongUpdates(app, 30) });
afterAll(() => server.stop(true));
const post = (p: string) =>
  fetch(`https://localhost:${server.port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", tls: { ca: cert.certPem } } as RequestInit).then(
    (r) => r.status,
    (e: Error) => e.message,
  );

describe("withLongUpdates", () => {
  test("the update limit covers the hub's wait for a node and stays within Bun's maximum", () => {
    expect(UPDATE_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(UPDATE_TIMEOUT_MS);
    expect(UPDATE_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  test("a slow update request outlives the server idle limit; another slow request does not", async () => {
    const [node, hub, cli, other] = await Promise.all(["/api/update", "/api/hosts/nas/update", "/cli/api/hosts/local/update", "/api/instances"].map(post));
    expect([node, hub, cli]).toEqual([200, 200, 200]);
    expect(String(other)).toMatch(/ECONNRESET|closed/);
  }, 20_000);
});

describe("withLongUpdates: GitHub routes", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const fetchApp = { fetch: () => new Response("ok") };
  const timeouts = async (method: string, p: string) => {
    const seen: [string, number][] = [];
    const server = { timeout: (req: Request, s: number) => void seen.push([new URL(req.url).pathname, s]) };
    await withLongUpdates(fetchApp, 190, 125)(new Request(`http://x${p}`, { method }), server as any);
    return seen;
  };

  test("the limit is above the repo-list wait and within Bun's maximum", () => {
    expect(GITHUB_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(REPOS_TIMEOUT_MS);
    expect(GITHUB_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  test("repo list (GET) and login start (POST) get the limit on node and hub paths", async () => {
    for (const p of ["/api/github/repos", "/api/hosts/nas/github/repos", "/cli/api/hosts/nas/github/repos"]) expect([p, await timeouts("GET", p)]).toEqual([p, [[p, 125]]]);
    for (const p of ["/api/github/login", "/api/hosts/nas/github/login", "/cli/api/hosts/local/github/login"]) expect([p, await timeouts("POST", p)]).toEqual([p, [[p, 125]]]);
  });

  test("other methods and paths are left alone, and update keeps its limit", async () => {
    for (const [m, p] of [
      ["GET", `/api/github/login/${ID}`], ["GET", `/api/hosts/nas/github/login/${ID}`], ["POST", "/api/github/repos"], ["GET", "/api/github/login"],
      ["POST", "/api/clone"], ["GET", `/api/clone/${ID}`], ["POST", "/api/hosts/nas/clone"], ["GET", "/api/github/repos/x"], ["GET", "/api/hosts/a/b/github/repos"], ["GET", "/other/api/github/repos"],
    ]) expect([m, p, await timeouts(m!, p!)]).toEqual([m, p, []]);
    expect(await timeouts("POST", "/api/hosts/nas/update")).toEqual([["/api/hosts/nas/update", 190]]);
  });
});
