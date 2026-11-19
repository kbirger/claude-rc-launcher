# Authentik Setup Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One script takes an empty authentik to a working hub: both providers and applications, the role mapping, groups, bindings, and the hub settings.

**Architecture:** A folder `scripts/authentik/` holds one module for each concern. A thin entry file `scripts/authentik-setup.ts` parses settings, optionally asks questions, runs the steps, and prints the result. Every step uses one shared API client that either describes a change (plan) or makes it (apply).

**Tech Stack:** Bun, TypeScript, `bun:test`, `node:readline/promises`.

**Spec:** `docs/superpowers/specs/2026-11-16-authentik-setup-design.md`

## Global Constraints

- Dry run is the default. Only `--apply` changes authentik or writes files.
- A second run changes nothing (`changes` is 0).
- The web client secret never appears in a log line, an error, or a test fixture.
- `AUTHENTIK_URL` must be https. Loopback hosts can use http.
- No overwrite of an existing secret file or `config.toml` value without `--force`.
- The hub reads `role_claim` and `role_scope` from `config.toml`. The snippet that the script prints must carry the same names that the script used.
- All lookups of applications use `superuser_full_list=true`.
- Text in README and messages follows the simple-english rules.

## Review Focus

- A `--public-url` with a trailing slash, a path, or plain http (non-loopback). Expect a clear error before any call.
- A second run where the provider exists and the secret file is gone. The script rewrites the file only when the API returns the secret. It says which case happened.
- A `config.toml` that has placeholders, comments, or no `[user_auth.oidc]` table. Expect that the writer edits only the known keys and keeps everything else.
- Interactive mode with an empty answer, with no terminal, and with an invalid answer. Expect the default, a refusal, and a repeated question.
- The group name or claim name that the operator changes. Expect that the mapping expression, the group attribute and the snippet all use the new name.

---

### Task 1: Split the script into modules without a change of behavior

**Files:**
- Create: `scripts/authentik/api.ts`, `scripts/authentik/roles.ts`, `scripts/authentik/settings.ts`
- Create: `scripts/authentik-setup.ts` (entry, replaces `scripts/authentik-roles.ts`)
- Delete: `scripts/authentik-roles.ts`
- Move: `server/test/authentik-roles.test.ts` to `server/test/authentik-setup.test.ts`

**Interfaces:**
- Produces in `api.ts`: `class ApiError(status, message)`, `type Ctx = { call(method, path, body?): Promise<any>, write(what, method, path, body?): Promise<any>, find(path, key, value): Promise<Json|undefined>, log(line): void, apply: boolean, changes(): number, problems: string[] }`, `makeCtx(o: { url, token, apply, fetch?, log? }): Ctx`.
- Produces in `settings.ts`: `type Settings` with the fields `claim, scope, mappingName, groups: {name, role}[], adminGroup, adminUser?, webApp: {slug, name, provider}, cliApp: {slug, name, provider}, oldHub: {application, provider}, removeOldHub`, and `DEFAULTS: Settings` (values equal to today's constants).
- Produces in `roles.ts`: `mappingExpression(claim: string): string`, `ensureRoles(ctx: Ctx, s: Settings): Promise<{ mappingPk?: string; groups: Map<string, Json|undefined> }>`.

- [ ] **Step 1:** Move the test file and change its imports to the new modules. Replace the constants (`MAPPING_EXPRESSION`, `GROUPS`, ...) with `DEFAULTS` and `mappingExpression(DEFAULTS.claim)`. Run `bun test server/test/authentik-setup.test.ts`. Expected: FAIL (modules do not exist).
- [ ] **Step 2:** Implement `api.ts` by moving `ApiError`, `call`, `write` and `find` out of `run()`. Implement `roles.ts` from steps 1 to 4 of the old `run()`. Keep the old `run(o)` in `authentik-setup.ts`. It calls the new modules, then does the bindings (step 5) and the old hub removal (step 6). It uses `DEFAULTS` for names. The group attribute name equals `s.claim`.
- [ ] **Step 3:** Run the same test file. Expected: all 11 tests PASS, with no change to assertions other than the imports.
- [ ] **Step 4:** Update the README mentions of `scripts/authentik-roles.ts` to `scripts/authentik-setup.ts`. Run `bun test` and `bunx tsc --noEmit`. Expected: green.
- [ ] **Step 5:** Commit: `git add scripts server/test README.md && git commit -m "refactor: split the authentik script into modules"`.

### Task 2: Settings from flags and environment variables

**Files:**
- Modify: `scripts/authentik/settings.ts`
- Test: `server/test/authentik-settings.test.ts`

**Interfaces:**
- Consumes: `Settings`, `DEFAULTS` (Task 1).
- Produces: `parseSettings(argv: string[], env: Record<string, string | undefined>): { settings: Settings; publicUrl: string; apply: boolean; interactive: boolean; secretFile: string; writeHubConfig?: string; force: boolean; url: string; token: string }`. It throws `Error` with a plain message on a bad value.

Flags: `--public-url`, `--web-slug`, `--cli-slug`, `--web-name`, `--cli-name`, `--claim`, `--scope`, `--admin-user`, `--write-hub-config <dir>`, `--force`, `--apply`, `--interactive`, `--remove-old-hub`.

`--group-prefix` sets the three group names to `<prefix>-admins`, `<prefix>-writers` and `<prefix>-ro`. `--secret-file` has the default `./oidc-client.secret`. Each flag has an environment variable `CLAUDERC_<NAME>` (for example `CLAUDERC_PUBLIC_URL`). A flag wins over the variable.

- [ ] **Step 1:** Write tests. Names: `defaults match the old constants`, `a flag wins over an environment variable`, `--group-prefix renames all three groups`, `public url must be https unless loopback`, `public url with a path or a trailing slash is cleaned to its origin`, `a slug must match [a-z0-9-]+`, `a missing public url is an error unless --interactive`. Assertions use `toEqual`/`toThrow(/https/)` on exact messages.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `parseSettings` in `settings.ts` with a small flag loop (no new dependency).
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit: `feat: settings for the authentik script`.

### Task 3: Providers and applications

**Files:**
- Create: `scripts/authentik/apps.ts`
- Modify: `server/test/authentik-setup.test.ts` (the fake authentik grows)
- Test: `server/test/authentik-apps.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `Settings`, `ensureRoles` result `mappingPk`.
- Produces: `ensureApplications(ctx: Ctx, s: Settings, publicUrl: string, mappingPk?: string): Promise<{ issuer: string; webClientId?: string; webClientSecret?: string; cliClientId?: string; cliJwksUrl: string }>`.

Order inside the setup: roles mapping, then applications (providers get the mapping at creation), then groups and bindings.

- [ ] **Step 1:** Extend the fake authentik with these routes: `GET/POST /api/v3/providers/oauth2/`, `GET/POST /api/v3/core/applications/`, `GET /api/v3/flows/instances/?slug=`, `GET /api/v3/crypto/certificatekeypairs/`, `GET /api/v3/propertymappings/provider/scope/?managed=` (openid, email, profile, offline_access). The fake returns a `client_secret` for a confidential provider.
- [ ] **Step 2:** Write tests. Names and assertions:
  - `creates the web provider as confidential with a strict redirect to <public-url>/auth/callback`: the POST body has `client_type: "confidential"`, one redirect URI with matching mode `strict`.
  - `creates the CLI provider as public with a loopback redirect pattern and offline_access`: `client_type: "public"`, the regex matches `http://127.0.0.1:41234/callback` and does not match `http://evil.example/callback`.
  - `both providers use the signing key, the flows, the default scope mappings and the role mapping`.
  - `creates both applications with the slugs and links the providers`.
  - `returns the issuer https://<authentik>/application/o/<web-slug>/ and the CLI jwks url`.
  - `a second run makes no write call`.
  - `a plan makes no write call and returns no secret`.
  - `an existing provider with a wrong redirect is repaired`.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement `ensureApplications` with `find` and `write`. Look up flows by slug (`default-provider-authorization-implicit-consent`, `default-provider-invalidation-flow`). Use the first key pair that has a private key as the signing key. The redirect field is a list of `{ matching_mode, url }` on the new API and a string on an older one. Try the list first and fall back on a 400, like the mapping path in the old code. Check the field names against a dry run on the real authentik before the last commit.
- [ ] **Step 5:** Run. Expected: PASS. Commit: `feat: the authentik script creates the providers and applications`.

### Task 4: Hub settings output

**Files:**
- Create: `scripts/authentik/hubconfig.ts`
- Test: `server/test/authentik-hubconfig.test.ts`

**Interfaces:**
- Consumes: the result of `ensureApplications`, `Settings`.
- Produces: `snippet(r: AppsResult, s: Settings): string` (TOML text without the secret), `writeSecret(path: string, secret: string, force: boolean): "written" | "kept"`, `writeHubConfig(dir: string, r: AppsResult, s: Settings, force: boolean): { changed: string[]; backup?: string }`.

- [ ] **Step 1:** Write tests with a temporary directory:
  - `snippet has issuer, client_id, role_claim, role_scope and the cli jwks_url and never the secret`.
  - `writeSecret creates a file with mode 600`, and `refuses to replace an existing file unless force` (returns `"kept"`).
  - `writeHubConfig sets the known keys, keeps comments and other tables, and writes config.toml.bak first`.
  - `writeHubConfig leaves a key with a different value alone unless force` and reports it in `changed`.
  - `writeHubConfig adds the [user_auth.oidc] table when it is missing`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Edit `config.toml` by line, key by key, inside the right table. Do not parse and re-serialize the file, so comments stay.
- [ ] **Step 4:** Run. Expected: PASS. Commit: `feat: print and write the hub settings`.

### Task 5: Interactive mode

**Files:**
- Create: `scripts/authentik/prompt.ts`
- Test: `server/test/authentik-prompt.test.ts`

**Interfaces:**
- Consumes: the `parseSettings` result.
- Produces: `type Io = { ask(question: string): Promise<string>; tty: boolean }`, `realIo(): Io`, `askSettings(base: ParsedOptions, io: Io): Promise<ParsedOptions>`.

Questions, in order: public URL, web slug, CLI slug, group prefix, claim name, scope name, admin user. Each shows the current value in brackets. An empty answer keeps it. An invalid answer repeats the question with the reason (same validators as Task 2).

- [ ] **Step 1:** Write tests with a scripted `Io`: `empty answers keep every default`, `an answer replaces the value`, `an invalid slug repeats the question once and then accepts a valid one`, `without a terminal it throws "needs a terminal"`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:readline/promises` in `realIo`. Export the validators from `settings.ts` so both places use them.
- [ ] **Step 4:** Run. Expected: PASS. Commit: `feat: interactive questions for the authentik script`.

### Task 6: Entry file, documentation, real check

**Files:**
- Modify: `scripts/authentik-setup.ts`, `README.md` (section "Authentik setup"), `docs/auth-architecture.md` (one line that names the script)
- Test: `server/test/authentik-setup.test.ts`

- [ ] **Step 1:** Add tests for the whole run on the fake authentik, from an empty state:
  - `an empty authentik ends with both applications, the mapping, three groups, nine bindings (two applications, three groups, no more) and the admin user in the admin group`.
  - `the printed output and every log line never contain the client secret`.
  - `--write-hub-config writes the secret file and the keys, and a second run keeps them`.
  - `a renamed claim shows up in the mapping expression, the group attribute and the snippet`.
- [ ] **Step 2:** Run. Expected: FAIL. Then wire the entry file. It parses the settings and asks the questions when `--interactive` is set. It runs the steps in order and prints the result. When the operator asks for it, it writes the secret and the hub settings. On an error it prints `error: ...` and exits with code 1.
- [ ] **Step 3:** Run `bun test` and `bunx tsc --noEmit`. Expected: green.
- [ ] **Step 4:** Rewrite the README section. Steps 1 to 9 become "run the script". Keep the manual steps below it for another provider or a manual setup. Run the simple-english check on the changed text.
- [ ] **Step 5:** Ask the operator to run the plan against the real authentik (no `--apply`). Expected: it reports that all objects exist and `changes` is 0, except the new bindings. If the plan fails, fix the field names from the real answers.
- [ ] **Step 6:** Commit: `feat: one script sets up authentik for the hub`.
