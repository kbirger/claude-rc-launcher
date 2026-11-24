# Authentication

The hub has no user database and no passwords. An identity provider (IdP) proves who a person is. The hub then decides what that person can do, from one role claim in the token. There is no mode without login. Only `GET /healthz` and `GET /cli/config` are open.

You choose one of two modes for the browser in `user_auth.mode`:

| Mode | Who logs the user in | Use it for |
|---|---|---|
| `oidc` | The hub, through OpenID Connect (OIDC) with your IdP. | This is the main mode. Your IdP must speak OIDC. |
| `proxy-jwt` | A reverse proxy in front of the hub (forward auth). The proxy sends a signed JWT (JSON Web Token) to the hub. | A proxy already protects your services and can send a signed JWT. |

The command-line client always uses OIDC, with its own public client. You can add CLI login to both modes. Read [CLI login](#cli-login).

The design, with diagrams, is in [Authentication and authorization architecture](auth-architecture.md).

## OIDC login

In `oidc` mode the hub is an OIDC relying party (a client that asks the IdP to log the user in). The flow is the authorization code flow with PKCE (a one-time secret that ties the code to this login).

1. The browser opens the hub. The hub sends it to the IdP.
2. The user signs in at the IdP.
3. The IdP sends the browser back to `public_url/auth/callback` with a code.
4. The hub exchanges the code for tokens at the token endpoint. It reads the claims of the ID token.
5. The hub sets a signed session cookie. The cookie is valid for `user_auth.session_ttl_hours` (12 hours by default).

The hub asks for the scopes `openid`, `email` and `profile`. If `user_auth.role_scope` is not empty, the hub also asks for that scope (`clauderc` by default).

### Requirements for any OIDC provider

The hub works with any OIDC provider that meets these requirements. Only authentik is tested.

For the web login (a confidential client):

1. The issuer URL must be `https`. The hub finds the endpoints through discovery (`<issuer>/.well-known/openid-configuration`). An `http://` issuer works only on a loopback address, or with `user_auth.oidc.allow_insecure = true`. Do not use that option in production, because the hub does not check the signature of the ID token from the token endpoint. It relies on TLS.
2. The client is a confidential client with a client secret. The client authenticates at the token endpoint with that secret.
3. The redirect URI is exactly `<public_url>/auth/callback`, for example `https://rc.example.com/auth/callback`.
4. The provider supports the authorization code flow with PKCE (S256).
5. The provider allows the scopes `openid`, `email` and `profile`. It also allows the role scope, if you set one.
6. The ID token has a `sub` claim. The hub reads the display name from `name`, then `preferred_username`, then `email`.
7. The ID token carries the role claim. The hub reads the role from the ID token, not from the userinfo endpoint. Read [Roles](#roles).
8. If the provider supports logout, the hub uses the `end_session_endpoint` from discovery.

Put the client secret in a file with mode 600, and name the file in `client_secret_file`:

```toml
public_url = "https://rc.example.com"

[user_auth]
mode = "oidc"
session_secret_file = "session.secret"      # openssl rand -hex 32
# default_role = "read"
# role_claim = "clauderc_role"
# role_scope = "clauderc"

[user_auth.oidc]
issuer = "https://idp.example.com/realms/home"
client_id = "claude-rc-launcher"
client_secret_file = "oidc-client.secret"
```

The full list of keys is in [Configuration](configuration.md#the-configuration-file).

### Who can sign in

The IdP decides who can sign in. Bind the application in the IdP to the intended users or groups. The role claim then decides what each person can do.

If your IdP cannot limit who signs in to one application, set `user_auth.allowed_users` to a list of usernames or email addresses. The hub checks it on every request. An email that the IdP marks with `email_verified: false` never matches, so that user must match by username.

## Roles

A person has one of three roles. The identity provider sets the role through one claim in the login token. The hub
enforces the role on every route of the web page and of the CLI. A node never sees a user token. It trusts the hub,
and the hub signs each request with the user and the role that it acts for. The node writes both to its audit log.

| Role | Can do |
|---|---|
| `read` | See instances, logs, files, the event stream, and update status |
| `write` | Everything in `read`. Also create, stop, pause, resume and restart instances, change their settings, make folders, clone repositories, list GitHub repositories, change permission rules, rename a node, and list SSH status, targets and grants |
| `admin` | Everything in `write`. Also register and remove nodes, run updates, start a GitHub login on a host, start an instance or a folder as another user or as root, and manage SSH delegation |

SSH delegation uses two levels. A `write` user can list the status, the targets and the grants. Only an `admin` can set it up, add or change a target, unlock a key, and approve, deny or revoke a grant. Read [SSH delegation](ssh-delegation.md).

A claim value of `none` refuses the person with 403. A value that is not a role name gives `read`. If the claim is a
list, the hub uses the highest role in it. A request that names a `user` other than the default `service_user` of
the node needs `admin`. A hub route that has no policy entry needs `admin`, and a test fails for a new route
that has none.

An existing browser session has no role. It acts as `read` until the person signs in again. After an upgrade,
make sure that your own user has the role `admin` **before** you start the new hub. Otherwise you are a reader and
you cannot give yourself the role from the web page.

The claim is the authority. `user_auth.allowed_users` stays as an optional second check. If you set it, both checks
must pass. The list exists for a provider that cannot limit which people can sign in to one application. With
authentik, bind the application to the intended users or groups, and leave the list unset.

### Role claim for other providers

The hub needs an OIDC provider with an https issuer, with the authorization code flow and PKCE. It also needs a way to
add one claim to the ID token. Set `role_claim` to the claim name. Set `role_scope` to the scope that makes the provider
send it, or to an empty string. Use `role_map` when the values of the claim are group names. For the CLI, the provider
needs a public client with a loopback redirect on `127.0.0.1` (any port) and refresh tokens.

To make a role claim in a provider other than authentik, use the feature that adds a custom claim to the ID token. For example, Keycloak has protocol mappers and client scopes, and Zitadel has actions. Two common ways work:

- Put a user attribute or a group attribute with the value `read`, `write`, `admin` or `none` into the claim `clauderc_role`.
- Put the group names of the user into the claim, and turn them into roles with `role_map`:

```toml
[user_auth]
role_claim = "groups"
role_scope = ""          # the provider sends the groups claim without an extra scope

[user_auth.role_map]
"rc-admins" = "admin"
"rc-writers" = "write"
"rc-readers" = "read"
```

## CLI login

### Enable CLI login on the hub

CLI login is off until you add a `[cli_auth.oidc]` table to the hub's `config.toml`. It needs a public OIDC
client (a client without a secret, protected by PKCE) in your identity provider.

```toml
[cli_auth.oidc]
issuer = "https://auth.example.com/application/o/claude-rc-cli/"
client_id = "..."
jwks_url = "https://auth.example.com/application/o/claude-rc-cli/jwks/"
```

The hub accepts an ID token of that client on `/cli/api`, and only there. Cookies and proxy headers do not work
on `/cli/api`, and a CLI token does not work on `/api`. `user_auth.allowed_users` applies to CLI logins. The
hub does not store any CLI session. The identity provider decides how long a token lives and can revoke a login.

In Authentik, create an OAuth2/OpenID provider for the CLI. Set the client type to **Public**. Add a redirect
URI in regular expression mode: `^http://127\.0\.0\.1:\d+/callback$`. Allow the scopes `openid`, `email`,
`profile` and `offline_access`. Select the grant types "Authorization Code" and "Refresh Token" (a provider
created through the API has none, and then every login fails with `invalid_request`). Select a signing key, because
the hub accepts only RS256, ES256 and EdDSA. Keep the ID token lifetime short. This works the same in `oidc` and `proxy-jwt`
mode. In `proxy-jwt` mode you must also let paths that start with `/cli/` through the proxy without its login
(in the Authentik proxy provider, add `^/cli/` to the unauthenticated paths). The hub still requires a valid token
on every `/cli/api` route.

The CLI client has these requirements in any provider:

1. The client is public. It has no secret. It uses PKCE (S256).
2. The redirect URI is `http://127.0.0.1:<port>/callback`, and the port changes at every login. The provider must accept any port on `127.0.0.1`, for example with a regular expression.
3. The provider allows the grant types "authorization code" and "refresh token".
4. The provider allows the scopes `openid`, `email`, `profile` and `offline_access`. It also allows the role scope, if you set one.
5. The ID token is signed with RS256, ES256 or EdDSA, and its audience is the `client_id`.
6. The ID token carries the same role claim as the web login.

The hub checks the signature of each CLI token with the keys at `jwks_url`.

## Forward auth with a signed JWT (proxy-jwt)

In `proxy-jwt` mode the hub does not log users in. A reverse proxy in front of the hub does it (forward auth: the proxy asks an auth server about each request). The proxy then adds a header with a signed JWT to each request to the hub. This is the second security model. It fits a setup where a forward-auth proxy already protects your services. It also fits a setup that has no OIDC client for the web login.

The hub does not trust the proxy. It trusts only the signature of the JWT:

- The hub checks the signature with the keys at `jwks_url`. You set that URL in the configuration. The hub never takes it from a header.
- The hub checks `iss`, `aud`, `exp` and `nbf`. The algorithm must be RS256, ES256 or EdDSA.
- The hub ignores plain identity headers such as `X-authentik-username` or `Remote-User`. A request sent straight to the hub with a forged header gets 401.
- `trusted_peers` can also limit the TCP peer to the address of the proxy. This is an extra layer, not the main control.
- The checks for CSRF (cross-site request forgery) stay on. There are no `/auth/*` routes. A missing or bad JWT gets 401, not a redirect.

The auth server must sign a JWT with a key that it publishes as a JWKS (JSON Web Key Set). Any proxy and auth server that do this work. The authentik proxy outpost sends the header `X-authentik-jwt`. A forward-auth proxy that sends only plain headers, such as `Remote-User`, is not enough.

```toml
public_url = "https://rc.example.com"

[user_auth]
mode = "proxy-jwt"

[user_auth.proxy_jwt]
header = "X-authentik-jwt"                     # the header that the proxy sends
jwks_url = "<the JWKS URL of the auth server>"
issuer = "<the iss claim of a real token>"
audience = "<the aud claim of a real token>"
trusted_peers = ["10.0.0.2"]                  # optional: the address of the proxy
logout_url = "<the logout URL of the proxy>"  # optional
```

Do not guess the values of `issuer` and `audience`. Decode a real JWT from the header, and copy the `iss` and `aud` claims from it.

The keys are in [proxy-jwt keys](configuration.md#proxy-jwt-keys). The role claim works in the same way as in `oidc` mode.

Keep these limits in mind:

- `/healthz` must be reachable without the proxy login.
- The CLI cannot pass the proxy login. Let paths that start with `/cli/` through the proxy without its login, and add `[cli_auth.oidc]`. The hub still requires a valid token on every `/cli/api` route.
- `session_secret_file` and `[user_auth.oidc]` are not allowed in this mode.

The setup for the authentik proxy outpost is in [Authentik proxy outpost](#authentik-proxy-outpost).

## Authentik setup script

The script `scripts/authentik-setup.ts` sets up authentik for the hub. It creates the web provider and application, the CLI provider and application, the role mapping, the three role groups, and the access bindings. It needs the address of authentik and an API token of an admin. It shows a plan and changes nothing, unless you pass `--apply`. You can run it again. It changes only what differs.

```sh
export AUTHENTIK_URL=https://auth.example.com
export AUTHENTIK_TOKEN=<an API token of an admin>
bun scripts/authentik-setup.ts --public-url https://rc.example.com --admin-user alex            # shows the plan
bun scripts/authentik-setup.ts --public-url https://rc.example.com --admin-user alex --apply   # makes the changes
```

After a run with `--apply`, the script prints the settings for `config.toml`. It writes the client secret to the file `./oidc-client.secret` with mode 600, and it never prints the secret. It does not replace an existing file, unless you pass `--force`. Use `--secret-file <path>` to choose another file.

To let the script write the hub settings, pass `--write-hub-config /etc/claude-rc-launcher`. The script then writes `oidc-client.secret` and the keys in `config.toml` in that directory. It makes the backup `config.toml.bak` first. It keeps a value that you set yourself, unless you pass `--force`. The script needs the right to write in that directory.

Pass `--interactive` to answer questions instead of flags. Each question shows the current value in brackets, and an empty answer keeps it. This needs a terminal.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--public-url` | `CLAUDERC_PUBLIC_URL` | none, required |
| `--web-slug`, `--cli-slug` | `CLAUDERC_WEB_SLUG`, `CLAUDERC_CLI_SLUG` | `claude-rc-launcher`, `claude-rc-cli` |
| `--web-name`, `--cli-name` | `CLAUDERC_WEB_NAME`, `CLAUDERC_CLI_NAME` | `Claude RC launcher`, `Claude RC CLI` |
| `--group-prefix` | `CLAUDERC_GROUP_PREFIX` | `ak-clauderc` (groups `-admins`, `-writers`, `-ro`) |
| `--claim`, `--scope` | `CLAUDERC_CLAIM`, `CLAUDERC_SCOPE` | `clauderc_role`, `clauderc` |
| `--admin-user` | `CLAUDERC_ADMIN_USER` | none |
| `--remove-old-hub` | none | off |

If you change `--claim` or `--scope`, the printed settings carry the same names. Use them in `role_claim` and `role_scope`.

## Authentik by hand

Use these steps with another setup, or when you do not want to run the script.

1. Applications > Providers > Create > **OAuth2/OpenID Provider**.
2. Client type: **Confidential**. Note the client ID and secret.
3. Redirect URI (strict): `https://rc.example.com/auth/callback` (i.e. `public_url/auth/callback`).
4. Scopes: `openid`, `email`, `profile`.
5. Create an **Application** using that provider; its slug gives the issuer URL
   `https://<authentik>/application/o/<slug>/` (use this as `user_auth.oidc.issuer`).
6. **Bind the application to the intended users/groups** (Application > Policy / Group / User
   Bindings). This is the access control.
7. **Add the role claim.** Customization > Property Mappings > Create > **Scope Mapping**. Set the name to
   `clauderc role` and the scope name to `clauderc`. Use this expression:

   ```python
   roles = [g.attributes.get("clauderc_role") for g in request.user.ak_groups.all()]
   return {"clauderc_role": [r for r in roles if r]}
   ```

   Add the mapping to the provider of the web login, and to the provider of the CLI login. A user in no role group gets
   `user_auth.default_role`.
8. **Set the role of each group.** Directory > Groups > the group > Attributes. Add `clauderc_role: admin`, or `write`,
   `read`, or `none`. A user who is in several role groups gets the highest role. Put each user in a group.
   Attach the mapping (step 7) and set the groups before you upgrade the hub.

9. **Let the role groups sign in.** Open each of the two applications, then Policy / Group / User Bindings. Bind each role group. A user who is in no bound group sees "Permission denied" at the login.

## Authentik proxy outpost

> The exact claims, issuer, audience and JWKS URL must be confirmed against your Authentik. Decode a real
> `X-authentik-jwt` header value and read them from the token. The header name is not in the token.
> `header` is the name of the header that you forward, for example `X-authentik-jwt`.

1. Create a **Proxy Provider** (forward auth, single application) and an application bound to the intended
   users/groups, and add it to the embedded or a dedicated outpost.
2. Set `[user_auth.proxy_jwt]`. Take `issuer`, `audience` and `jwks_url` from the decoded token. Set `header`
   to the name of the header that you forward, for example `X-authentik-jwt`.
3. Behind Traefik use a forward-auth middleware that copies the JWT to the hub, and route the outpost's own
   path to the outpost:

```yaml
http:
  middlewares:
    authentik:
      forwardAuth:
        address: http://authentik-outpost:9000/outpost.goauthentik.io/auth/traefik
        trustForwardHeader: true
        authResponseHeaders:
          - X-authentik-jwt
          - X-authentik-username
  routers:
    claude-rc:
      rule: Host(`rc.example.com`)
      middlewares: [authentik]
      service: claude-rc
    claude-rc-outpost:
      rule: Host(`rc.example.com`) && PathPrefix(`/outpost.goauthentik.io/`)
      service: authentik-outpost
    claude-rc-health:                 # /healthz must be reachable without authentication
      rule: Host(`rc.example.com`) && Path(`/healthz`)
      service: claude-rc
```

Only the verified JWT is trusted; `X-authentik-username` is ignored. Set `trusted_peers` to the proxy's
address as an extra layer.

## Nodes need no IdP

Nodes need no Authentik setup. The hub does not use an account at the identity provider to call nodes.
It signs each request with its own key. Run `claude-rc node config` or `claude-rc node setup` to give a node
the hub public key (see [Command-line client](cli.md)).
