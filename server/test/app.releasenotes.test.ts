import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { mintSessionCookie, oidcUserAuth, type OidcClient, type User } from "../src/auth";
import type { Config } from "../src/config";
import type { createReleaseList, ReleaseNotes } from "../src/releaselist";

const user: User = { sub: "u1", name: "Ann", email: "a@x.io" };
const oidc: OidcClient = {
  async authorizationUrl() { return "https://idp/authorize"; },
  async exchange() { return user; },
};
let cfg: Config;
let cookie: string;

beforeAll(async () => {
  cfg = { publicUrl: "https://rc.example.com", roots: [], hosts: [],
    userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" } } } as unknown as Config;
  cookie = await mintSessionCookie(cfg, user, Date.now() + 3600_000);
});
afterAll(() => {});

describe("GET /api/release-notes", () => {
  const notes: ReleaseNotes = {
    releases: [{ version: "0.9.0", name: "v0.9.0", body: "b", url: "https://x/0.9.0", publishedAt: "2026-11-09T00:00:00Z" }],
    complete: true,
  };
  const withList = (releaseList?: ReturnType<typeof createReleaseList>) =>
    createApp({ cfg, instances: {} as any, userAuth: oidcUserAuth(cfg, oidc), ...(releaseList ? { releaseList } : {}) });
  const get = (app: any, qs: string) => app.request(`/api/release-notes${qs}`, { headers: { cookie } });

  test("returns the slice for from and to", async () => {
    const calls: [string, string][] = [];
    const app = withList({ between: async (f, t) => { calls.push([f, t]); return notes; } });
    const r = await get(app, "?from=0.8.0&to=0.9.0");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(notes);
    expect(calls).toEqual([["0.8.0", "0.9.0"]]);
  });

  test("answers 400 when from or to is missing", async () => {
    const app = withList({ between: async () => notes });
    for (const qs of ["", "?from=0.8.0", "?to=0.9.0", "?from=&to=0.9.0"]) {
      expect((await get(app, qs)).status).toBe(400);
    }
  });

  test("answers 501 when the host has no release list", async () => {
    const r = await get(withList(), "?from=0.8.0&to=0.9.0");
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: "release notes are not available on this host" });
  });

  test("needs the same login as /api/latest", async () => {
    const r = await withList({ between: async () => notes }).request("/api/release-notes?from=0.8.0&to=0.9.0");
    expect(r.status).toBe(401);
  });
});
