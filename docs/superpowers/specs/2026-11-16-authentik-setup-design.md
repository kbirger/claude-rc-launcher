# Authentik setup script: design

Status: waiting for approval.

## Intent

An operator with an empty authentik must reach a working hub with one command. Today `scripts/authentik-roles.ts` does only the roles part. The two applications and providers are made by hand. The script must also let the operator choose names, and later other settings that the hub exposes.

## Goals

- One script makes everything that the hub needs in authentik: the web provider and application, the CLI provider and application, the role mapping, the role groups, and the access bindings.
- It is safe to run twice. It changes only what differs.
- It shows a plan and changes nothing unless the operator passes `--apply`.
- Every name has a flag and an environment variable, with the current constant as the default.
- `--interactive` asks for each setting, with the default shown. It is off by default, and it never runs without a terminal.
- The script prints a `config.toml` snippet. It holds the values that the hub also reads: `role_claim`, `role_scope`, issuer, client id and CLI `jwks_url`. So both sides always agree.

## Non-goals

- No support for an identity provider other than authentik. The README section "Using another identity provider" stays the guide for that.
- No change to how the hub reads roles.
- No removal of other applications. Only the old hub application and provider can be removed, and only with `--remove-old-hub`.

## Anti-goals

- The web client secret is never printed and never put in a log or in a test fixture.
- The script never overwrites an existing secret file or `config.toml` value without `--force`.

## Approaches

1. Keep one growing file. This is quick. But the file already holds the API client, the roles and the plan logic. It would also hold the prompts and the hub configuration writer.
2. Split into a folder `scripts/authentik/`, with one module for each concern. The modules are the API client with plan and apply, the roles step, the applications step, the prompts and the hub configuration writer. One entry file `scripts/authentik-setup.ts` calls them. This is my pick. Each module has its own test.
3. Generate an authentik blueprint (YAML) and let the operator import it. Authentik supports blueprints. They cannot read back the client secret. They are also harder to show as a plan.

## Design

Entry: `scripts/authentik-setup.ts`. It replaces `scripts/authentik-roles.ts`. The README and tests change to the new name.

Settings, each with flag, environment variable and default:
- `--public-url` (required, for the redirect `https://<host>/auth/callback`)
- application names and slugs (defaults `claude-rc-launcher`, `claude-rc-cli`)
- provider names (defaults as today)
- group names and the admin user
- claim name and scope name (defaults `clauderc_role` and `clauderc`)
- authorization flow (default: the implicit-consent flow, found by slug)

The steps run in this order: scope mapping, web provider, CLI provider, applications, mapping on both providers, groups, admin user, bindings, and the optional old hub removal. The web provider is confidential, with a strict redirect and the scopes `openid email profile` plus the role scope. The CLI provider is public, with a loopback redirect pattern for `127.0.0.1` and refresh tokens. Lookups use `superuser_full_list=true`, so that access rules do not hide an application.

Output: the plan or the result, then the `config.toml` snippet. The web secret goes to the file in `--secret-file` (default `./oidc-client.secret`, mode 600). With `--write-hub-config <dir>`, the script writes the secret to `<dir>/oidc-client.secret` and sets the values in `<dir>/config.toml`. It needs the rights to write there. It makes a backup of the `config.toml` file first.

Interactive mode: a small prompt module (question, default, validation) over `readline`. A test passes scripted answers.

## Left to the builder

- Exact authentik API fields for the redirect settings and the refresh token validity. Check them against a dry run on the real instance.
- How to read the secret of an existing provider on a second run. If the API does not return it, a second run does not touch the secret file.
- Test layout. The existing in-memory fake authentik grows to cover providers and applications.
