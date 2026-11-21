import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { instanceApi, onError } from "../src/app";
import type { Config } from "../src/config";

const ID = "0123456789ab";
const cfg = { mode: "node", name: "n", port: 1, host: "x", roots: ["/tmp"], hosts: [], stateDir: "/tmp/sessionindex-route" } as unknown as Config;
const instances: any = { list: async () => [], stop: async () => {}, users: async () => ({ selectable: false, default: "u", users: [] }), trustFilter: async () => () => true, claudeHome: async () => ({ path: "/p", home: "/h" }) };

function build() {
  const calls = { get: 0, invalidate: 0 };
  const sessionIndex: any = { get: async () => (calls.get++, { scannedAt: "2026-01-01T00:00:00.000Z", sessions: [] }), invalidate: () => void calls.invalidate++ };
  const app = new Hono();
  app.onError(onError);
  app.route("/", instanceApi({ cfg, instances, sessionIndex }));
  return { app, calls };
}

describe("GET /sessions on the node API", () => {
  test("answers with the index answer", async () => {
    const { app, calls } = build();
    const res = await app.request("/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scannedAt: "2026-01-01T00:00:00.000Z", sessions: [] });
    expect(calls.get).toBe(1);
  });

  test("a successful write under /instances calls invalidate", async () => {
    const { app, calls } = build();
    expect((await app.request(`/instances/${ID}`, { method: "DELETE" })).status).toBe(204);
    expect(calls.invalidate).toBe(1);
  });

  test("a failed write under /instances does not call invalidate", async () => {
    const { app, calls } = build();
    const res = await app.request("/instances", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
    expect(calls.invalidate).toBe(0);
  });

  test("a read under /instances does not call invalidate", async () => {
    const { app, calls } = build();
    await app.request("/instances");
    expect(calls.invalidate).toBe(0);
  });
});
