import { describe, expect, test } from "bun:test";
import { ADMIN_GROUP, APPLICATIONS, GROUPS, MAPPING_EXPRESSION, MAPPING_NAME, OLD_HUB, PROVIDERS, run, SCOPE_NAME } from "../../scripts/authentik-roles";

type Json = Record<string, any>;

/** A small in-memory authentik: only the routes that the script uses. */
function fakeAuthentik(opts: { providers?: string[]; newMappingPath?: boolean } = {}) {
  let id = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`;
  const mappings: Json[] = [];
  const providers: Json[] = (opts.providers ?? [...PROVIDERS, OLD_HUB.provider]).map((name, i) => ({ pk: 20 + i, name, property_mappings: ["existing-mapping"] }));
  const groups: Json[] = [];
  const users: Json[] = [{ pk: 7, username: "kir" }];
  const apps: Json[] = [...APPLICATIONS, OLD_HUB.application].map((slug, i) => ({ slug, pk: `app-${i}` }));
  const bindings: Json[] = [];
  const calls: { method: string; path: string; body?: any; auth?: string | null }[] = [];

  const list = (items: Json[], q: URLSearchParams, key: string) => ({ results: items.filter((x) => !q.has(key) || x[key] === q.get(key)) });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, auth: new Headers(init?.headers).get("authorization") });
    const out = (status: number, data?: unknown) => new Response(data === undefined ? "" : JSON.stringify(data), { status });
    const p = url.pathname;
    const mapBase = opts.newMappingPath === false ? "/api/v3/propertymappings/scope/" : "/api/v3/propertymappings/provider/scope/";
    if (p.startsWith("/api/v3/propertymappings/") && !p.startsWith(mapBase)) return out(404, { detail: "not found" });
    if (p === mapBase && method === "GET") return out(200, list(mappings, url.searchParams, "name"));
    if (p === mapBase && method === "POST") {
      const m = { pk: uuid(), ...body };
      mappings.push(m);
      return out(201, m);
    }
    const mm = p.startsWith(mapBase) ? mappings.find((x) => p === `${mapBase}${x.pk}/`) : undefined;
    if (mm && method === "PATCH") return out(200, Object.assign(mm, body));
    if (p === "/api/v3/providers/oauth2/" && method === "GET") return out(200, list(providers, url.searchParams, "name"));
    const pm = providers.find((x) => p === `/api/v3/providers/oauth2/${x.pk}/`);
    if (pm && method === "PATCH") return out(200, Object.assign(pm, body));
    if (pm && method === "DELETE") return (providers.splice(providers.indexOf(pm), 1), out(204));
    if (p === "/api/v3/core/groups/" && method === "GET") return out(200, list(groups, url.searchParams, "name"));
    if (p === "/api/v3/core/groups/" && method === "POST") {
      const g = { pk: uuid(), users: [], ...body };
      groups.push(g);
      return out(201, g);
    }
    const gm = groups.find((x) => p.startsWith(`/api/v3/core/groups/${x.pk}/`));
    if (gm && method === "PATCH") return out(200, Object.assign(gm, body));
    if (gm && p.endsWith("/add_user/") && method === "POST") return (gm.users.push(body.pk), out(204));
    if (p === "/api/v3/policies/bindings/" && method === "GET") return out(200, { results: bindings.filter((b) => !url.searchParams.has("target") || b.target === url.searchParams.get("target")) });
    if (p === "/api/v3/policies/bindings/" && method === "POST") {
      const b = { pk: uuid(), ...body };
      bindings.push(b);
      return out(201, b);
    }
    if (p === "/api/v3/core/users/" && method === "GET") return out(200, list(users, url.searchParams, "username"));
    if (p === "/api/v3/core/applications/" && method === "GET") return out(200, list(apps, url.searchParams, "slug"));
    const am = apps.find((x) => p === `/api/v3/core/applications/${x.slug}/`);
    if (am && method === "DELETE") return (apps.splice(apps.indexOf(am), 1), out(204));
    return out(404, { detail: `no route ${method} ${p}` });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, mappings, providers, groups, apps, bindings, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

const base = (fake: ReturnType<typeof fakeAuthentik>, over: Partial<Parameters<typeof run>[0]> = {}) => {
  const log: string[] = [];
  return { log, o: { url: "https://auth.example.com/", token: "sekret-token", apply: true, removeOldHub: false, fetch: fake.fetch, log: (l: string) => log.push(l), ...over } };
};

describe("authentik-roles", () => {
  test("a plan makes no write call and says what it would do", async () => {
    const a = fakeAuthentik();
    const { o, log } = base(a, { apply: false, adminUser: "kir" });
    const r = await run(o);
    expect(a.writes()).toEqual([]);
    expect(r.changes).toBeGreaterThan(0);
    expect(log.some((l) => l.startsWith("would create the scope mapping"))).toBe(true);
    expect(log.some((l) => l.startsWith("would add kir to"))).toBe(true);
    expect(log.at(-1)).toContain("--apply");
  });

  test("apply creates the mapping, adds it to both providers, makes the groups and adds the user", async () => {
    const a = fakeAuthentik();
    await run(base(a, { adminUser: "kir" }).o);
    expect(a.mappings).toHaveLength(1);
    expect(a.mappings[0]).toMatchObject({ name: MAPPING_NAME, scope_name: SCOPE_NAME, expression: MAPPING_EXPRESSION });
    const pk = a.mappings[0]!.pk;
    for (const name of PROVIDERS) expect(a.providers.find((p) => p.name === name)!.property_mappings).toEqual(["existing-mapping", pk]);
    expect(a.providers.find((p) => p.name === OLD_HUB.provider)!.property_mappings).toEqual(["existing-mapping"]);
    expect(a.groups.map((g) => [g.name, g.attributes.clauderc_role])).toEqual(GROUPS.map((g) => [g.name, g.role]));
    expect(a.groups.find((g) => g.name === ADMIN_GROUP)!.users).toEqual([7]);
  });

  test("every role group is bound to both applications, once", async () => {
    const a = fakeAuthentik();
    await run(base(a).o);
    expect(a.bindings).toHaveLength(APPLICATIONS.length * GROUPS.length);
    for (const slug of APPLICATIONS) {
      const app = a.apps.find((x) => x.slug === slug)!;
      const groupsBound = a.bindings.filter((b) => b.target === app.pk).map((b) => a.groups.find((g) => g.pk === b.group)?.name);
      expect(groupsBound.sort()).toEqual(GROUPS.map((g) => g.name).sort());
    }
    // the old hub application gets none
    expect(a.bindings.some((b) => b.target === a.apps.find((x) => x.slug === OLD_HUB.application)!.pk)).toBe(false);
  });

  test("a missing application is reported", async () => {
    const a = fakeAuthentik();
    a.apps.splice(a.apps.findIndex((x) => x.slug === APPLICATIONS[1]), 1);
    await expect(run(base(a).o)).rejects.toThrow(/application not found: claude-rc-cli/);
  });

  test("a second run changes nothing", async () => {
    const a = fakeAuthentik();
    await run(base(a, { adminUser: "kir" }).o);
    const before = a.writes().length;
    const again = await run(base(a, { adminUser: "kir" }).o);
    expect(again.changes).toBe(0);
    expect(a.writes()).toHaveLength(before);
  });

  test("a changed expression and a wrong group attribute are repaired", async () => {
    const a = fakeAuthentik();
    await run(base(a).o);
    a.mappings[0]!.expression = "return {}";
    a.groups[0]!.attributes = { clauderc_role: "read", keep: "me" };
    const r = await run(base(a).o);
    expect(r.changes).toBe(2);
    expect(a.mappings[0]!.expression).toBe(MAPPING_EXPRESSION);
    expect(a.groups[0]!.attributes).toEqual({ clauderc_role: "admin", keep: "me" });
  });

  test("an older authentik with the mapping under the old path works", async () => {
    const a = fakeAuthentik({ newMappingPath: false });
    await run(base(a).o);
    expect(a.mappings).toHaveLength(1);
  });

  test("a missing provider or user is reported after the rest is done", async () => {
    const a = fakeAuthentik({ providers: [PROVIDERS[0]!] });
    await expect(run(base(a, { adminUser: "nobody" }).o)).rejects.toThrow(/provider not found: Provider for Claude RC CLI.*user not found: nobody/);
    expect(a.groups).toHaveLength(GROUPS.length);
  });

  test("the old hub application and provider go only with the flag and with apply", async () => {
    const a = fakeAuthentik();
    await run(base(a).o);
    expect(a.apps).toHaveLength(APPLICATIONS.length + 1);
    expect(a.providers.some((p) => p.name === OLD_HUB.provider)).toBe(true);
    await run(base(a, { removeOldHub: true, apply: false }).o);
    expect(a.apps).toHaveLength(APPLICATIONS.length + 1);
    await run(base(a, { removeOldHub: true }).o);
    expect(a.apps).toHaveLength(APPLICATIONS.length);
    expect(a.providers.some((p) => p.name === OLD_HUB.provider)).toBe(false);
    // already gone: a second run is quiet
    expect((await run(base(a, { removeOldHub: true }).o)).changes).toBe(0);
  });

  test("the token is sent as a bearer and never logged", async () => {
    const a = fakeAuthentik();
    const { o, log } = base(a);
    await run(o);
    expect(new Set(a.calls.map((c) => c.auth))).toEqual(new Set(["Bearer sekret-token"]));
    expect(log.join("\n")).not.toContain("sekret-token");
  });

  test("an API error names the call and not the token", async () => {
    const a = fakeAuthentik();
    const failing = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(run({ ...base(a).o, fetch: failing })).rejects.toThrow(/GET .* failed: HTTP 403 denied/);
  });
});
