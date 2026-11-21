import { DEFAULTS } from "../../scripts/authentik/settings";

const APPLICATIONS = [DEFAULTS.webApp.slug, DEFAULTS.cliApp.slug];
const PROVIDERS = [DEFAULTS.webApp.provider, DEFAULTS.cliApp.provider];
const OLD_HUB = DEFAULTS.oldHub;

export type Json = Record<string, any>;

/** A small in-memory authentik: only the routes that the script uses. */
export function fakeAuthentik(
  opts: {
    providers?: string[];
    apps?: string[];
    newMappingPath?: boolean;
    redirectAsString?: boolean;
    noFlows?: boolean;
    rejectProviders?: boolean;
  } = {},
) {
  let id = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`;
  const mappings: Json[] = [];
  const providers: Json[] = (opts.providers ?? [...PROVIDERS, OLD_HUB.provider]).map((name, index) => ({
    pk: 20 + index,
    name,
    property_mappings: ["existing-mapping"],
  }));
  const groups: Json[] = [];
  const users: Json[] = [{ pk: 7, username: "kir" }];
  const apps: Json[] = (opts.apps ?? [...APPLICATIONS, OLD_HUB.application]).map((slug, index) => ({
    slug,
    pk: `app-${index}`,
    policy_engine_mode: "any",
  }));
  const bindings: Json[] = [];
  const managed: Json[] = ["openid", "email", "profile", "offline_access"].map((count) => ({
    pk: `managed-${count}`,
    name: count,
    managed: `goauthentik.io/providers/oauth2/scope-${count}`,
  }));
  let providerPk = 100;
  const calls: { method: string; path: string; body?: any; auth?: string | null }[] = [];

  const list = (items: Json[], searchParams: URLSearchParams, key: string) => ({
    results: items.filter((json) => !searchParams.has(key) || json[key] === searchParams.get(key)),
  });
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      path: url.pathname + url.search,
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const out = (status: number, data?: unknown) =>
      new Response(data === undefined ? "" : JSON.stringify(data), { status });
    const item = url.pathname;
    const mapBase =
      opts.newMappingPath === false ? "/api/v3/propertymappings/scope/" : "/api/v3/propertymappings/provider/scope/";
    if (item.startsWith("/api/v3/propertymappings/") && !item.startsWith(mapBase))
      return Promise.resolve(out(404, { detail: "not found" }));
    if (item === mapBase && method === "GET" && url.searchParams.has("managed"))
      return Promise.resolve(out(200, list(managed, url.searchParams, "managed")));
    if (item === mapBase && method === "GET")
      return Promise.resolve(out(200, list(mappings, url.searchParams, "name")));

    if (item === mapBase && method === "POST") {
      const entry = { pk: uuid(), ...body };
      mappings.push(entry);
      return Promise.resolve(out(201, entry));
    }

    const mm = item.startsWith(mapBase) ? mappings.find((json) => item === `${mapBase}${json.pk}/`) : undefined;
    if (mm && method === "PATCH") return Promise.resolve(out(200, Object.assign(mm, body)));
    if (item === "/api/v3/providers/oauth2/" && method === "GET")
      return Promise.resolve(out(200, list(providers, url.searchParams, "name")));
    const pm = providers.find((json) => item === `/api/v3/providers/oauth2/${json.pk}/`);

    if (item === "/api/v3/providers/oauth2/" && method === "POST") {
      if (opts.rejectProviders) return Promise.resolve(out(400, { name: ["bad name"] }));
      if (opts.redirectAsString && Array.isArray(body.redirect_uris))
        return Promise.resolve(out(400, { redirect_uris: ["Not a valid string."] }));
      const pk = ++providerPk;
      const made = {
        pk,
        client_id: `cid-${pk}`,
        ...(body.client_type === "confidential" ? { client_secret: `fake-secret-${pk}` } : {}),
        ...body,
      };
      providers.push(made);
      return Promise.resolve(out(201, made));
    }

    if (pm && method === "GET") return Promise.resolve(out(200, pm));
    if (item === "/api/v3/flows/instances/" && method === "GET")
      return Promise.resolve(
        out(
          200,
          list(
            opts.noFlows
              ? []
              : ["default-provider-authorization-implicit-consent", "default-provider-invalidation-flow"].map(
                  (slug) => ({
                    slug,
                    pk: `flow-${slug}`,
                  }),
                ),
            url.searchParams,
            "slug",
          ),
        ),
      );
    if (item === "/api/v3/crypto/certificatekeypairs/" && method === "GET")
      return Promise.resolve(out(200, { results: [{ pk: "key-1", name: "authentik Self-signed Certificate" }] }));

    if (item === "/api/v3/core/applications/" && method === "POST") {
      const made = { pk: uuid(), ...body };
      apps.push(made);
      return Promise.resolve(out(201, made));
    }

    if (pm && method === "PATCH") return Promise.resolve(out(200, Object.assign(pm, body)));
    if (pm && method === "DELETE") return Promise.resolve((providers.splice(providers.indexOf(pm), 1), out(204)));
    if (item === "/api/v3/core/groups/" && method === "GET")
      return Promise.resolve(out(200, list(groups, url.searchParams, "name")));

    if (item === "/api/v3/core/groups/" && method === "POST") {
      const entry = { pk: uuid(), users: [], ...body };
      groups.push(entry);
      return Promise.resolve(out(201, entry));
    }

    const gm = groups.find((json) => item.startsWith(`/api/v3/core/groups/${json.pk}/`));
    if (gm && method === "PATCH") return Promise.resolve(out(200, Object.assign(gm, body)));
    if (gm && item.endsWith("/add_user/") && method === "POST")
      return Promise.resolve((gm.users.push(body.pk), out(204)));
    if (item === "/api/v3/policies/bindings/" && method === "GET")
      return Promise.resolve(
        out(200, {
          results: bindings.filter(
            (json) => !url.searchParams.has("target") || json.target === url.searchParams.get("target"),
          ),
        }),
      );

    if (item === "/api/v3/policies/bindings/" && method === "POST") {
      const entry = { pk: uuid(), ...body };
      bindings.push(entry);
      return Promise.resolve(out(201, entry));
    }

    if (item === "/api/v3/core/users/" && method === "GET")
      return Promise.resolve(out(200, list(users, url.searchParams, "username")));
    if (item === "/api/v3/core/applications/" && method === "GET")
      return Promise.resolve(out(200, list(apps, url.searchParams, "slug")));
    const am = apps.find((json) => item === `/api/v3/core/applications/${json.slug}/`);
    if (am && method === "PATCH") return Promise.resolve(out(200, Object.assign(am, body)));
    if (am && method === "PATCH") return Promise.resolve(out(200, Object.assign(am, body)));
    if (am && method === "DELETE") return Promise.resolve((apps.splice(apps.indexOf(am), 1), out(204)));
    return Promise.resolve(out(404, { detail: `no route ${method} ${item}` }));
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    mappings,
    providers,
    groups,
    apps,
    bindings,
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
  };
}
