import { describe, expect, test } from "bun:test";
import { run } from "../../scripts/authentik-setup";
import { mappingExpression } from "../../scripts/authentik/roles";
import { DEFAULTS } from "../../scripts/authentik/settings";

const MAPPING_EXPRESSION = mappingExpression(DEFAULTS.claim);
const MAPPING_NAME = DEFAULTS.mappingName;
const SCOPE_NAME = DEFAULTS.scope;
const GROUPS = DEFAULTS.groups;
const ADMIN_GROUP = DEFAULTS.adminGroup;
const APPLICATIONS = [DEFAULTS.webApp.slug, DEFAULTS.cliApp.slug];
const PROVIDERS = [DEFAULTS.webApp.provider, DEFAULTS.cliApp.provider];
const OLD_HUB = DEFAULTS.oldHub;

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHubConfig, writeSecret } from "../../scripts/authentik/hubconfig";
import { fakeAuthentik } from "./authentik-fake";

const base = (fake: ReturnType<typeof fakeAuthentik>, over: Partial<Parameters<typeof run>[0]> = {}) => {
  const log: string[] = [];
  return { log, o: { url: "https://auth.example.com/", token: "sekret-token", apply: true, removeOldHub: false, fetch: fake.fetch, log: (l: string) => log.push(l), ...over } };
};

describe("authentik-setup", () => {
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

  test("an application in the all mode is set to any", async () => {
    const a = fakeAuthentik();
    a.apps.find((x) => x.slug === APPLICATIONS[0])!.policy_engine_mode = "all";
    await run(base(a).o);
    for (const slug of APPLICATIONS) expect(a.apps.find((x) => x.slug === slug)!.policy_engine_mode).toBe("any");
    expect(a.writes().filter((c) => c.method === "PATCH" && c.path === `/api/v3/core/applications/${APPLICATIONS[0]}/`)).toHaveLength(1);
  });

  test("a binding that is not a role group is reported and not deleted", async () => {
    const a = fakeAuthentik();
    await run(base(a).o);
    const app = a.apps.find((x) => x.slug === APPLICATIONS[0])!;
    a.bindings.push({ pk: "stray", target: app.pk, user: 7, user_obj: { username: "kir" }, order: 0 });
    await expect(run(base(a).o)).rejects.toThrow(/"claude-rc-launcher" has a binding for the user kir/);
    expect(a.bindings.some((b) => b.pk === "stray")).toBe(true);
    expect(a.writes().some((c) => c.method === "DELETE" && c.path.includes("bindings"))).toBe(false);
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
    const err = await run(base(a, { adminUser: "nobody" }).o).catch((e) => String(e));
    expect(err).toContain("provider not found: Provider for Claude RC CLI");
    expect(err).toContain("user not found: nobody");
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

describe("authentik-setup from an empty authentik", () => {
  const empty = () => fakeAuthentik({ providers: [], apps: [] });
  const withUrl = { publicUrl: "https://rc.example.com" };

  test("ends with both applications, the mapping, three groups, six bindings and the admin in the admin group", async () => {
    const a = empty();
    const r = await run(base(a, { adminUser: "kir", ...withUrl }).o);
    expect(a.apps.map((x) => x.slug)).toEqual(APPLICATIONS);
    expect(a.mappings).toHaveLength(1);
    expect(a.groups).toHaveLength(3);
    expect(a.bindings).toHaveLength(6);
    expect(a.groups.find((g) => g.name === ADMIN_GROUP)!.users).toEqual([7]);
    expect(r.apps?.webClientSecret).toBeDefined();
    for (const p of a.providers) expect(p.property_mappings).toContain(a.mappings[0]!.pk);
  });
  test("a plan from an empty authentik makes no write and does not fail on the missing applications", async () => {
    const a = empty();
    const { o, log } = base(a, { apply: false, ...withUrl });
    await run(o);
    expect(a.writes()).toEqual([]);
    expect(log.some((l) => l.includes("after the application exists"))).toBe(true);
  });
  test("no log line contains the client secret or the token", async () => {
    const a = empty();
    const { o, log } = base(a, withUrl);
    const r = await run(o);
    expect(log.join("\n")).not.toContain(r.apps!.webClientSecret!);
    expect(log.join("\n")).not.toContain("sekret-token");
  });
  test("the secret file and the hub settings are written, and a second run keeps them", async () => {
    const a = empty();
    const r = await run(base(a, withUrl).o);
    const d = mkdtempSync(join(tmpdir(), "setup-"));
    writeFileSync(join(d, "config.toml"), 'mode = "hub"\n');
    expect(writeSecret(join(d, "oidc-client.secret"), r.apps!.webClientSecret!, false)).toBe("written");
    writeHubConfig(d, r.apps!, DEFAULTS, false);
    const again = await run(base(a, withUrl).o);
    expect(again.changes).toBe(0);
    expect(writeSecret(join(d, "oidc-client.secret"), again.apps!.webClientSecret!, false)).toBe("kept");
    expect(writeHubConfig(d, again.apps!, DEFAULTS, false).changed).toEqual([]);
    expect(readFileSync(join(d, "config.toml"), "utf8")).toContain(`client_id = "${r.apps!.webClientId}"`);
  });
  test("a renamed claim shows up in the mapping expression, the group attribute and the snippet", async () => {
    const a = empty();
    const settings = { ...DEFAULTS, claim: "my_role" };
    const r = await run(base(a, { ...withUrl, settings }).o);
    expect(a.mappings[0]!.expression).toContain('"my_role"');
    expect(a.groups[0]!.attributes).toEqual({ my_role: "admin" });
    const { snippet } = await import("../../scripts/authentik/hubconfig");
    expect(snippet(r.apps!, settings)).toContain('role_claim = "my_role"');
  });
});
