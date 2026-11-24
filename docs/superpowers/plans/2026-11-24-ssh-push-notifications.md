# SSH push notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub sends a Web Push message to the subscribed devices of admins when a session requests SSH access. The message has an `Open` button and a `Deny` button.

**Architecture:** A new hub module keeps a VAPID key pair and a device subscription file, and sends pushes. A small route set under `/push` registers devices. `SshService` calls a notifier after a real request. The web service worker shows the message and handles the click and `Deny`. The SSH page has a switch to subscribe a device.

**Tech Stack:** Bun, Hono, `web-push` (hub), SvelteKit service worker, Svelte 5, TanStack Query, vitest (web), `bun test` (server).

**Spec:** `docs/superpowers/specs/2026-11-24-ssh-push-notifications-design.md`

## Global Constraints

- Branch `feat/ssh-delegation`. Do not push, publish or deploy.
- Files that hold keys or subscriptions: mode 600, folder 700, written with the same helper style as `server/src/sshkeystore.ts` (O_EXCL temp file, then rename).
- A push never holds key material, a key line, a passphrase or a grant secret. The text holds target id, instance name, minutes and the reason cut to 120 characters.
- A test grant (`test: true`) sends no push.
- A failed push never throws out of the request path. Log lines name the endpoint host only (use `logToken`).
- Routes under `/push` need role `admin` and appear in the route table of `server/src/roles.ts` (see how the `/ssh` rows are written).
- Tests must not touch the real `/root` or the real state folder: use temp folders.
- Web code follows the shadcn and Tailwind style of `web/src/lib/features/ssh/`. Run `svelte-autofixer` on every new `.svelte` file.
- Plain English in docs and UI text: no contractions, no em-dashes.

## Review Focus

- A subscription that the push service answers with 404 or 410 is deleted, and one bad endpoint does not stop the other sends.
- A repeat `POST /push/subscribe` with the same endpoint replaces the entry and does not grow the file. A user over 20 entries loses the oldest.
- `POST /push/unsubscribe` with an endpoint that belongs to another user changes nothing and answers 404.
- A hostile reason string (newlines, 5000 characters, HTML) reaches the payload cut and as plain text only.
- The `Deny` button after the grant already ended (409) opens `/ssh` and does not show an error page.

---

### Task 1: Push module (keys, subscriptions, sender)

**Files:**
- Create: `server/src/webpush.ts`, `server/src/webpush.test.ts`
- Modify: `package.json` (dependency `web-push` and its types `@types/web-push` if needed)

**Interfaces:**
- Produces:
  - `export interface PushSubscriptionJson { endpoint: string. keys: { p256dh: string. auth: string } }`
  - `export interface PushMessage { title: string. body: string. url: string. tag: string. grantId?: string. close?: boolean }`
  - `export type PushTransport = (sub: PushSubscriptionJson, payload: string, vapid: { publicKey: string. privateKey: string. subject: string }) => Promise<{ status: number }>` (the default uses `web-push`. tests pass a fake)
  - `export class PushService { constructor(options: { dir: string. subject: string. transport?: PushTransport. audit?: (line: string) => void }). publicKey(): Promise<string>. subscribe(userId: string, sub: PushSubscriptionJson): Promise<void>. unsubscribe(userId: string, endpoint: string): Promise<boolean>. send(message: PushMessage): Promise<void> }`
  - `send` goes to every stored subscription (all were registered by admins). It never rejects.

- [ ] **Step 1: Write failing tests** in `webpush.test.ts` (temp dir, fake transport): `creates the VAPID pair once and reuses it` (second `PushService` on the same dir returns the same public key. file mode 600, folder 700). `subscribe replaces an entry with the same endpoint`. `subscribe keeps at most 20 entries per user and drops the oldest`. `subscribe rejects an endpoint that is not https` (throw an `Error` the route turns into 400). `unsubscribe removes only an entry of the same user`. `send calls the transport for each entry`. `send deletes an entry on 404 and 410 and keeps it on 500`. `send does not stop when one transport call throws`. `send logs the endpoint host only` (audit line has the host, not the path or keys).
- [ ] **Step 2: Run** `bun test server/src/webpush.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `PushService`** in `server/src/webpush.ts`. State files `<dir>/vapid.json` and `<dir>/subscriptions.json`. Generate keys with `webpush.generateVAPIDKeys()`. The default transport calls `webpush.sendNotification` with the VAPID details and `TTL: 600`, and maps a `WebPushError` to its `statusCode`. Serialize file writes with one promise chain so two calls cannot lose an entry.
- [ ] **Step 4: Check the library in the compiled binary.** Run `bun install`, then `bun run build` (or the quicker `bun build --compile server/src/index.ts --outfile /tmp/push-check` from the repo root) and run a one-line script that imports `web-push` and calls `generateVAPIDKeys()` under `bun`. If the library fails under Bun or the compile, write the aes128gcm encryption (RFC 8291) and the VAPID JWT with `node:crypto` and `jose` instead, keep the same interface, and say so in the report.
- [ ] **Step 5: Run** the tests again. Expected: PASS. Run `bun run typecheck` (or the repo's typecheck command from `package.json`).
- [ ] **Step 6: Commit** `feat(push): VAPID keys, device subscriptions and a sender`.

### Task 2: Push routes and wiring

**Files:**
- Create: `server/src/pushapi.ts`, `server/src/pushapi.test.ts`
- Modify: `server/src/roles.ts` (rows), `server/src/app.ts` (mount next to the `/ssh` routes, in both the browser and CLI API trees where `sshRoutes` is mounted), `server/src/hubmain.ts` (create `PushService` with `dir = <stateDir>/push` and `subject = cfg.publicUrl`), the roles route-table test if one lists all routes

**Interfaces:**
- Consumes: `PushService` from Task 1. `options.user(context)` style of `server/src/sshapi.ts` for the user id.
- Produces: `export function pushApi(options: { push: PushService. user: (context: Context) => string. audit: (line: string) => void }): Hono` with `GET /key` (`{ key }`), `POST /subscribe` (body is a `PushSubscriptionJson`, answers 204), `POST /unsubscribe` (body `{ endpoint }`, 204 or 404).

- [ ] **Step 1: Write failing tests** with a fake `PushService`: `GET /key returns the public key`. `POST /subscribe stores for the caller and answers 204`. `POST /subscribe answers 400 for a body without keys or with an http endpoint`. `POST /unsubscribe answers 404 for an endpoint of another user`. In the roles test file, add rows `GET /push/key` and `POST /push/subscribe`, `POST /push/unsubscribe` as `admin` (a `write` user gets 403).
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** `pushApi`, the role rows, the mounts and the `hubmain` wiring. Audit writes like `auditWrites` in `sshapi.ts` (user and path only, never the endpoint or keys).
- [ ] **Step 4: Run** `bun test server` and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): routes to register a device`.

### Task 3: Notify on a new SSH request

**Files:**
- Create: `server/src/sshnotify.ts`, `server/src/sshnotify.test.ts`
- Modify: `server/src/sshservice.ts` (dependency `notify?`), `server/src/hubmain.ts` (connect `PushService.send`), `server/src/sshservice.test.ts`

**Interfaces:**
- Consumes: `PushService.send`. `Grant` and `Target` types (`server/src/sshgrants.ts`, `sshtargets.ts`).
- Produces: `export function requestMessage(grant: Grant, target: Target, instanceName: string): PushMessage` with `title` `SSH access requested`, `body` `<target.id> on <instance>, <minutes> min: <reason cut to 120, control characters replaced by spaces>`, `url` `/ssh`, `tag` `ssh-<grant.id>`, `grantId`. `SshServiceDeps.notify?: (message: PushMessage) => void`.

- [ ] **Step 1: Write failing tests**: in `sshnotify.test.ts`, `names target, instance, minutes and reason`, `cuts a 5000 character reason to 120`, `replaces newlines and control characters`, `holds no secret field` (message JSON has only the known keys). In `sshservice.test.ts`, `a real request calls notify once`, `a test grant does not call notify`, `a refused request does not call notify`, `a throwing notify does not fail the request`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `requestMessage`. call `notify` in `SshService` right after `grants.request` succeeds (wrap in try/catch, audit on error). The instance name comes from the same source that the grant list shows (use what `sshservice.ts` already has for the instance label, or the instance id if none). In `hubmain.ts` pass `notify: (message) => void push.send(message)`.
- [ ] **Step 4: Run** `bun test server` and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): notify admins of a new SSH request`.

### Task 4: Service worker and the SSH page switch

**Files:**
- Create: `web/src/lib/features/push/worker.ts` (pure functions for the handlers), `web/src/lib/features/push/worker.test.ts`, `web/src/lib/features/push/api.ts`, `web/src/lib/features/push/NotifySwitch.svelte`, `web/src/lib/features/push/NotifySwitch.test.ts`, a harness file in the style of the other `*Harness.svelte` files if needed
- Modify: `web/src/service-worker.ts`, `web/src/lib/features/ssh/SshPage.svelte` (place the switch near the top), `web/src/lib/features/ssh/SshPage.test.ts`

**Interfaces:**
- Consumes: hub routes of Task 2 and the existing `deny` route `POST /ssh/grants/:id/deny` (check how `web/src/lib/features/ssh/api.ts` calls it and whether the hub needs a CSRF header or origin check from a worker `fetch`. use the same call).
- Produces in `worker.ts`: `parsePush(data: string): PushMessage | undefined` (returns `undefined` for bad JSON), `notificationOptions(message): NotificationOptions` (tag, body, icon `/icon-192.png`, `data: { url, grantId }`, actions `[{action:"open",title:"Open"},{action:"deny",title:"Deny"}]` only when `grantId` is set), `handleClick(action: string, data: { url: string. grantId?: string }, deps: { deny: (grantId: string) => Promise<Response>. open: (url: string) => Promise<void> }): Promise<void>` (action `deny` calls `deny`. a non-ok answer or a throw calls `open(url)`. every other action calls `open(url)`).

- [ ] **Step 1: Write failing tests** for `worker.ts` (`parsePush returns undefined for bad JSON`, `options carry tag and two actions only with a grant id`, `deny action calls deny and does not open`, `a 409 from deny opens /ssh`, `a thrown deny opens /ssh`, `no action opens the url`) and for `NotifySwitch` (`is hidden without PushManager`, `is off when permission is denied and says how to allow it`, `turning on asks permission, subscribes with the hub key and posts the subscription`, `turning off unsubscribes the browser and calls the hub`, `shows an error text when the hub refuses`).
- [ ] **Step 2: Run** `bun run --cwd web test` for the new files. Expected: FAIL.
- [ ] **Step 3: Implement** `worker.ts`, wire it into `service-worker.ts` (`push` event calls `showNotification` inside `event.waitUntil`, and shows a generic notification `SSH access requested` when the payload cannot be parsed, because Chrome requires a visible notification for each push. `notificationclick` closes the notification and calls `handleClick`, where `open` focuses a window client on `/ssh` or opens one). Implement `api.ts` and `NotifySwitch.svelte` (shadcn switch, text `Notify this device`, short help line under it). Keep the existing cache and fetch handlers unchanged.
- [ ] **Step 4: Run** the web tests, `svelte-check` and `svelte-autofixer`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(web): push notifications for SSH requests with a Deny button`.

### Task 5: Close the notification on other devices

**Files:**
- Modify: `server/src/sshservice.ts` (`onGrantEnd` also calls `notify` with a close message), `server/src/sshnotify.ts` (`closeMessage(grant)`), `web/src/lib/features/push/worker.ts`, `web/src/service-worker.ts`, and their tests

**Interfaces:**
- Produces: `closeMessage(grant: Grant): PushMessage` with the same `tag`, `close: true`, empty `body`. In `worker.ts`: `notificationOptions` for a `close` message is not used. The `push` handler for `close: true` shows a notification with the same tag (this satisfies the browser rule that each push shows one) and then closes it at once by `getNotifications({ tag })`.

- [ ] **Step 1: Write failing tests**: `onGrantEnd for a grant that was pending sends a close message once`, `a test grant sends none`, `closeMessage holds only tag, grantId and close`, and a worker test with a fake registration that checks show then close for the same tag.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** If the show-then-close trick is not reliable on Chrome, the owner can drop this task: keep it a separate commit.
- [ ] **Step 4: Run** server and web tests, typecheck, `svelte-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): close the notification when a grant ends`.

### Task 6: Documentation

**Files:**
- Modify: `docs/ssh-delegation.md` (section `Notifications`), `docs/web-ui.md` (the switch), `docs/security.md` (what a push holds and that a demoted admin keeps the subscription until they unsubscribe or the push service drops it), `docs/configuration.md` (state folder `push/`. no new key)

- [ ] **Step 1: Write the sections** in plain English (the `simple-english` hook checks the files). State the hand checks: delivery to Android Chrome, `Deny`, close on another device, Safari without buttons.
- [ ] **Step 2: Run** the repo's docs check if one exists (look in `package.json` scripts and `docs/development.md`). Commit `docs(push): notifications for SSH requests`.
