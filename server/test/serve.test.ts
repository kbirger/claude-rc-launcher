import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { UPDATE_IDLE_TIMEOUT_SECONDS, withLongUpdates } from "../src/serve";
import { UPDATE_TIMEOUT_MS } from "../src/hosts";
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
