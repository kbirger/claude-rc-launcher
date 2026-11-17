import { DEFAULTS } from "../../scripts/authentik/settings";

const APPLICATIONS = [DEFAULTS.webApp.slug, DEFAULTS.cliApp.slug];
const PROVIDERS = [DEFAULTS.webApp.provider, DEFAULTS.cliApp.provider];
const OLD_HUB = DEFAULTS.oldHub;

export type Json = Record<string, any>;

/** A small in-memory authentik: only the routes that the script uses. */
export function fakeAuthentik(opts: { providers?: string[]; apps?: string[]; newMappingPath?: boolean; redirectAsString?: boolean } = {}) {
  let id = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`;
  const mappings: Json[] = [];
  const providers: Json[] = (opts.providers ?? [...PROVIDERS, OLD_HUB.provider]).map((name, i) => ({ pk: 20 + i, name, property_mappings: ["existing-mapping"] }));
  const groups: Json[] = [];
  const users: Json[] = [{ pk: 7, username: "kir" }];
  const apps: Json[] = (opts.apps ?? [...APPLICATIONS, OLD_HUB.application]).map((slug, i) => ({ slug, pk: `app-${i}`, policy_engine_mode: "any" }));
  const bindings: Json[] = [];
  const managed: Json[] = ["openid", "email", "profile", "offline_access"].map((n) => ({ pk: `managed-${n}`, name: n, managed: `goauthentik.io/providers/oauth2/scope-${n}` }));
  let providerPk = 100;
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
    if (p === mapBase && method === "GET" && url.searchParams.has("managed")) return out(200, list(managed, url.searchParams, "managed"));
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
    if (p === "/api/v3/providers/oauth2/" && method === "POST") {
      if (opts.redirectAsString && Array.isArray(body.redirect_uris)) return out(400, { redirect_uris: ["Not a valid string."] });
      const pk = ++providerPk;
      const made = { pk, client_id: `cid-${pk}`, ...(body.client_type === "confidential" ? { client_secret: `fake-secret-${pk}` } : {}), ...body };
      providers.push(made);
      return out(201, made);
    }
    if (pm && method === "GET") return out(200, pm);
    if (p === "/api/v3/flows/instances/" && method === "GET") return out(200, list(["default-provider-authorization-implicit-consent", "default-provider-invalidation-flow"].map((slug) => ({ slug, pk: `flow-${slug}` })), url.searchParams, "slug"));
    if (p === "/api/v3/crypto/certificatekeypairs/" && method === "GET") return out(200, { results: [{ pk: "key-1", name: "authentik Self-signed Certificate" }] });
    if (p === "/api/v3/core/applications/" && method === "POST") {
      const made = { pk: uuid(), ...body };
      apps.push(made);
      return out(201, made);
    }
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
    if (am && method === "PATCH") return out(200, Object.assign(am, body));
    if (am && method === "DELETE") return (apps.splice(apps.indexOf(am), 1), out(204));
    return out(404, { detail: `no route ${method} ${p}` });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, mappings, providers, groups, apps, bindings, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

