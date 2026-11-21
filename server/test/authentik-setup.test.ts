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
import { rejection, defined } from "./support";

const base = (fake: ReturnType<typeof fakeAuthentik>, over: Partial<Parameters<typeof run>[0]> = {}) => {
  const log: string[] = [];
  return {
    log,
    options: {
      url: "https://auth.example.com/",
      token: "sekret-token",
      apply: true,
      removeOldHub: false,
      fetch: fake.fetch,
      log: (line: string) => log.push(line),
      ...over,
    },
  };
};

describe("authentik-setup", () => {
  test("a plan makes no write call and says what it would do", async () => {
    const authentik = fakeAuthentik();
    const { options: entry, log } = base(authentik, { apply: false, adminUser: "kir" });
    const outcome = await run(entry);
    expect(authentik.writes()).toEqual([]);
    expect(outcome.changes).toBeGreaterThan(0);
    expect(log.some((item) => item.startsWith("would create the scope mapping"))).toBe(true);
    expect(log.some((item) => item.startsWith("would add kir to"))).toBe(true);
    expect(log.at(-1)).toContain("--apply");
  });

  test("apply creates the mapping, adds it to both providers, makes the groups and adds the user", async () => {
    const authentik = fakeAuthentik();
    await run(base(authentik, { adminUser: "kir" }).options);
    expect(authentik.mappings).toHaveLength(1);
    expect(authentik.mappings[0]).toMatchObject({
      name: MAPPING_NAME,
      scope_name: SCOPE_NAME,
      expression: MAPPING_EXPRESSION,
    });
    const pk = authentik.mappings[0].pk;
    for (const name of PROVIDERS)
      expect(defined(authentik.providers.find((json) => json.name === name)).property_mappings).toEqual([
        "existing-mapping",
        pk,
      ]);
    expect(defined(authentik.providers.find((json) => json.name === OLD_HUB.provider)).property_mappings).toEqual([
      "existing-mapping",
    ]);
    expect(authentik.groups.map((json) => [json.name, json.attributes.clauderc_role])).toEqual(
      GROUPS.map((item) => [item.name, item.role]),
    );
    expect(defined(authentik.groups.find((json) => json.name === ADMIN_GROUP)).users).toEqual([7]);
  });

  test("every role group is bound to both applications, once", async () => {
    const authentik = fakeAuthentik();
    await run(base(authentik).options);
    expect(authentik.bindings).toHaveLength(APPLICATIONS.length * GROUPS.length);

    for (const slug of APPLICATIONS) {
      const app = defined(authentik.apps.find((json) => json.slug === slug));
      const groupsBound = authentik.bindings
        .filter((json) => json.target === app.pk)
        .map((json) => authentik.groups.find((group) => group.pk === json.group)?.name);
      expect(groupsBound.sort()).toEqual(GROUPS.map((item) => item.name).sort());
    }

    // the old hub application gets none
    expect(
      authentik.bindings.some(
        (json) => json.target === defined(authentik.apps.find((app) => app.slug === OLD_HUB.application)).pk,
      ),
    ).toBe(false);
  });

  test("an application in the all mode is set to any", async () => {
    const authentik = fakeAuthentik();
    defined(authentik.apps.find((json) => json.slug === APPLICATIONS[0])).policy_engine_mode = "all";
    await run(base(authentik).options);
    for (const slug of APPLICATIONS)
      expect(defined(authentik.apps.find((json) => json.slug === slug)).policy_engine_mode).toBe("any");
    expect(
      authentik
        .writes()
        .filter((write) => write.method === "PATCH" && write.path === `/api/v3/core/applications/${APPLICATIONS[0]}/`),
    ).toHaveLength(1);
  });

  test("a binding that is not a role group is reported and not deleted", async () => {
    const authentik = fakeAuthentik();
    await run(base(authentik).options);
    const app = defined(authentik.apps.find((json) => json.slug === APPLICATIONS[0]));
    authentik.bindings.push({ pk: "stray", target: app.pk, user: 7, user_obj: { username: "kir" }, order: 0 });
    expect((await rejection(run(base(authentik).options))).message).toMatch(
      /"claude-rc-launcher" has a binding for the user kir/,
    );
    expect(authentik.bindings.some((json) => json.pk === "stray")).toBe(true);
    expect(authentik.writes().some((write) => write.method === "DELETE" && write.path.includes("bindings"))).toBe(
      false,
    );
  });

  test("a missing application is reported", async () => {
    const authentik = fakeAuthentik();
    authentik.apps.splice(
      authentik.apps.findIndex((json) => json.slug === APPLICATIONS[1]),
      1,
    );
    expect((await rejection(run(base(authentik).options))).message).toMatch(/application not found: claude-rc-cli/);
  });

  test("a second run changes nothing", async () => {
    const authentik = fakeAuthentik();
    await run(base(authentik, { adminUser: "kir" }).options);
    const before = authentik.writes().length;
    const again = await run(base(authentik, { adminUser: "kir" }).options);
    expect(again.changes).toBe(0);
    expect(authentik.writes()).toHaveLength(before);
  });

  test("a changed expression and a wrong group attribute are repaired", async () => {
    const authentik = fakeAuthentik();
    await run(base(authentik).options);
    authentik.mappings[0].expression = "return {}";
    authentik.groups[0].attributes = { clauderc_role: "read", keep: "me" };
    const outcome = await run(base(authentik).options);
    expect(outcome.changes).toBe(2);
    expect(authentik.mappings[0].expression).toBe(MAPPING_EXPRESSION);
    expect(authentik.groups[0].attributes).toEqual({ clauderc_role: "admin", keep: "me" });
  });

  test("an older authentik with the mapping under the old path works", async () => {
    const authentik = fakeAuthentik({ newMappingPath: false });
    await run(base(authentik).options);
    expect(authentik.mappings).toHaveLength(1);
  });

  test("a missing provider or user is reported after the rest is done", async () => {
    const authentik = fakeAuthentik({ providers: [PROVIDERS[0]] });
    const err = await run(base(authentik, { adminUser: "nobody" }).options).catch((error) => String(error));
    expect(err).toContain("provider not found: Provider for Claude RC CLI");
    expect(err).toContain("user not found: nobody");
    expect(authentik.groups).toHaveLength(GROUPS.length);
  });

  test("the old hub application and provider go only with the flag and with apply", async () => {
    const authentik = fakeAuthentik();
    await run(base(authentik).options);
    expect(authentik.apps).toHaveLength(APPLICATIONS.length + 1);
    expect(authentik.providers.some((json) => json.name === OLD_HUB.provider)).toBe(true);
    await run(base(authentik, { removeOldHub: true, apply: false }).options);
    expect(authentik.apps).toHaveLength(APPLICATIONS.length + 1);
    await run(base(authentik, { removeOldHub: true }).options);
    expect(authentik.apps).toHaveLength(APPLICATIONS.length);
    expect(authentik.providers.some((json) => json.name === OLD_HUB.provider)).toBe(false);
    // already gone: a second run is quiet
    expect((await run(base(authentik, { removeOldHub: true }).options)).changes).toBe(0);
  });

  test("the token is sent as a bearer and never logged", async () => {
    const authentik = fakeAuthentik();
    const { options: entry, log } = base(authentik);
    await run(entry);
    expect(new Set(authentik.calls.map((call) => call.auth))).toEqual(new Set(["Bearer sekret-token"]));
    expect(log.join("\n")).not.toContain("sekret-token");
  });

  test("an API error names the call and not the token", async () => {
    const authentik = fakeAuthentik();
    const failing = (() => Promise.resolve(new Response("denied", { status: 403 }))) as unknown as typeof fetch;
    expect((await rejection(run({ ...base(authentik).options, fetch: failing }))).message).toMatch(
      /GET .* failed: HTTP 403 denied/,
    );
  });
});

describe("authentik-setup from an empty authentik", () => {
  const empty = () => fakeAuthentik({ providers: [], apps: [] });
  const withUrl = { publicUrl: "https://rc.example.com" };

  test("ends with both applications, the mapping, three groups, six bindings and the admin in the admin group", async () => {
    const harness = empty();
    const outcome = await run(base(harness, { adminUser: "kir", ...withUrl }).options);
    expect(harness.apps.map((json) => json.slug)).toEqual(APPLICATIONS);
    expect(harness.mappings).toHaveLength(1);
    expect(harness.groups).toHaveLength(3);
    expect(harness.bindings).toHaveLength(6);
    expect(defined(harness.groups.find((json) => json.name === ADMIN_GROUP)).users).toEqual([7]);
    expect(outcome.apps?.webClientSecret).toBeDefined();
    for (const json of harness.providers) expect(json.property_mappings).toContain(harness.mappings[0].pk);
  });
  test("a plan from an empty authentik makes no write and does not fail on the missing applications", async () => {
    const harness = empty();
    const { options: entry, log } = base(harness, { apply: false, ...withUrl });
    await run(entry);
    expect(harness.writes()).toEqual([]);
    expect(log.some((item) => item.includes("after the application exists"))).toBe(true);
  });
  test("no log line contains the client secret or the token", async () => {
    const harness = empty();
    const { options: entry, log } = base(harness, withUrl);
    const outcome = await run(entry);
    expect(log.join("\n")).not.toContain(defined(defined(outcome.apps).webClientSecret));
    expect(log.join("\n")).not.toContain("sekret-token");
  });
  test("the secret file and the hub settings are written, and a second run keeps them", async () => {
    const harness = empty();
    const outcome = await run(base(harness, withUrl).options);
    const file = mkdtempSync(join(tmpdir(), "setup-"));
    writeFileSync(join(file, "config.toml"), 'mode = "hub"\n');
    expect(writeSecret(join(file, "oidc-client.secret"), defined(defined(outcome.apps).webClientSecret), false)).toBe(
      "written",
    );
    writeHubConfig(file, defined(outcome.apps), DEFAULTS, false);
    const again = await run(base(harness, withUrl).options);
    expect(again.changes).toBe(0);
    expect(writeSecret(join(file, "oidc-client.secret"), defined(defined(again.apps).webClientSecret), false)).toBe(
      "kept",
    );
    expect(writeHubConfig(file, defined(again.apps), DEFAULTS, false).changed).toEqual([]);
    expect(readFileSync(join(file, "config.toml"), "utf8")).toContain(
      `client_id = "${defined(outcome.apps).webClientId}"`,
    );
  });
  test("a renamed claim shows up in the mapping expression, the group attribute and the snippet", async () => {
    const harness = empty();
    const settings = { ...DEFAULTS, claim: "my_role" };
    const outcome = await run(base(harness, { ...withUrl, settings }).options);
    expect(harness.mappings[0].expression).toContain('"my_role"');
    expect(harness.groups[0].attributes).toEqual({ my_role: "admin" });
    const { snippet } = await import("../../scripts/authentik/hubconfig");
    expect(snippet(defined(outcome.apps), settings)).toContain('role_claim = "my_role"');
  });
});
