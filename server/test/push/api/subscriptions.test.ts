import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { onError } from "../../../src/app";
import { pushApi } from "../../../src/push/api/subscriptions";
import { PushValidationError } from "../../../src/push/PushService";
import type { PushService, PushSubscriptionJson } from "../../../src/push/PushService";
import { requiredRole } from "../../../src/roles";

const good = (endpoint = "https://push.example.com/a"): PushSubscriptionJson => ({
  endpoint,
  keys: { p256dh: "p", auth: "a" },
});

function setup() {
  const stored: [string, PushSubscriptionJson][] = [];
  const failure: { error?: Error } = {};
  const lines: string[] = [];
  const push = {
    publicKey: () => Promise.resolve("PUBKEY"),
    subscribe: (user: string, sub: PushSubscriptionJson) => {
      if (failure.error) return Promise.reject(failure.error);
      if (!sub.endpoint.startsWith("https:"))
        return Promise.reject(new PushValidationError("the push endpoint must use https"));
      stored.push([user, sub]);
      return Promise.resolve();
    },
    unsubscribe: (user: string, endpoint: string) =>
      Promise.resolve(stored.some(([owner, item]) => owner === user && item.endpoint === endpoint)),
  } as unknown as PushService;

  const as: MiddlewareHandler = async (context, next) => {
    context.set("user" as never, { username: context.req.header("x-user") ?? "ann", role: "admin" } as never);
    await next();
  };

  const app = new Hono();
  app.use("*", as);
  app.route(
    "/push",
    pushApi({
      push,
      user: (context) => (context.get("user" as never) as { username: string }).username,
      audit: (line) => lines.push(line),
    }),
  );
  app.onError(onError);
  const call = (method: string, path: string, body?: unknown, user = "ann") =>
    app.request(`/push${path}`, {
      method,
      headers: { "content-type": "application/json", "x-user": user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, stored, lines, failure };
}

describe("push api", () => {
  test("GET /key returns the public key", async () => {
    const { call } = setup();
    const response = await call("GET", "/key");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: "PUBKEY" });
  });

  test("POST /subscribe stores for the caller and answers 204", async () => {
    const { call, stored, lines } = setup();
    expect((await call("POST", "/subscribe", good())).status).toBe(204);
    expect(stored).toEqual([["ann", good()]]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("push POST /push/subscribe 204");
    expect(lines[0]).not.toContain("push.example.com");
  });

  test("POST /subscribe answers 400 for a body without keys or with an http endpoint", async () => {
    const { call, stored } = setup();
    expect((await call("POST", "/subscribe", { endpoint: "https://push.example.com/a" })).status).toBe(400);
    expect((await call("POST", "/subscribe", { endpoint: "https://x/a", keys: { p256dh: "p" } })).status).toBe(400);
    expect((await call("POST", "/subscribe", good("http://push.example.com/a"))).status).toBe(400);
    expect((await call("POST", "/subscribe", [])).status).toBe(400);
    expect(stored).toEqual([]);
  });

  test("a store failure answers 500 with a fixed text and no raw message", async () => {
    const { call, failure } = setup();
    failure.error = new Error("EACCES: /var/lib/secret/path");
    const response = await call("POST", "/subscribe", good());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("the subscription could not be saved");
    expect(text).not.toContain("EACCES");
  });

  test("POST /unsubscribe answers 204 for an own endpoint and 404 for one of another user", async () => {
    const { call } = setup();
    await call("POST", "/subscribe", good());
    expect((await call("POST", "/unsubscribe", { endpoint: good().endpoint }, "bob")).status).toBe(404);
    expect((await call("POST", "/unsubscribe", { endpoint: good().endpoint })).status).toBe(204);
    expect((await call("POST", "/unsubscribe", {})).status).toBe(400);
  });

  test("the roles table needs admin for all three routes", () => {
    expect(requiredRole("GET", "/push/key")).toBe("admin");
    expect(requiredRole("POST", "/push/subscribe")).toBe("admin");
    expect(requiredRole("POST", "/push/unsubscribe")).toBe("admin");
  });
});
