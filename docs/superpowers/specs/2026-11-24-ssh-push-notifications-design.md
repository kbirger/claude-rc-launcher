# Push notifications for SSH requests: design

Date: 2026-11-24. Status: approved by the owner on 2026-11-24 (choice: Web Push, not ntfy).

## Intent

A session asks for SSH access, and the owner is away from the page. The owner needs a message on the phone that names the request and opens the approval page. Today the owner must open the web app and look.

## Goals

- A Web Push message on every new real pending SSH grant, to each subscribed device of every admin.
- A `Deny` button in the notification. `Approve` stays on the page, because the unlock needs a passkey or passphrase.
- No new hub setting. The feature is on for a device that subscribed.

## Non-goals

- No other event types (session finished, update ready). The sender takes a title, a body and a link, so later events can reuse it.
- No ntfy channel. A notifier interface is not built until a second channel exists.
- No push for a test grant.

## Design

Hub, new file `server/src/webpush.ts`:

- VAPID key pair created on first use and saved at `<state_dir>/push/vapid.json` (mode 600, folder 700). The VAPID subject is `public_url`.
- Subscription store `<state_dir>/push/subscriptions.json` (mode 600). An entry holds the user id, the endpoint, the two keys and the creation time. The endpoint is the key, so a repeat registration replaces the entry. A cap of 20 entries per user drops the oldest.
- `send(userIds, {title, body, url, tag, grantId})` sends to every subscription of those users. A 404 or 410 answer deletes the entry. Other failures are logged with the endpoint host only and never stop the request.
- Library: `web-push`. If it does not work in the compiled Bun binary, write the encryption with `node:crypto` and `jose`.

Hub routes (under `/push`, any signed-in user who can reach the SSH page, which is role admin):

- `GET /push/key` returns the public VAPID key.
- `POST /push/subscribe` takes the browser subscription JSON and stores it for the caller.
- `POST /push/unsubscribe` takes the endpoint. If the entry belongs to the caller, the route removes it.

Trigger: in `SshService` after `grants.request` succeeds for a real request, call the notifier for all admin users. The text names the target, the instance name, the minutes and the reason (cut to 120 characters). The text holds no key material. The click opens `/ssh`. The notification tag is `ssh-<grantId>`.

If a grant leaves `pending` (approved, denied or expired), the hub sends a small push with the same tag and `close: true`. The worker closes that notification. This clears it on the other devices.

Web:

- `web/src/service-worker.ts` gets a `push` handler, a `notificationclick` handler and a `Deny` action. `Deny` calls `POST /ssh/grants/<id>/deny` with the cookie, and a failed call opens `/ssh` instead. A click with no action focuses or opens `/ssh`.
- The SSH page gets a switch `Notify this device`. It asks for the browser permission, subscribes with the public key, and posts the subscription. Turning it off unsubscribes the browser and calls the unsubscribe route. If the browser has no push support, the page hides the switch.

## Constraints

- The hub only sends. It never sends a secret, a key line or a passphrase.
- Roles: read and write users get no subscription route, because they cannot approve.
- iOS and Safari show no action buttons. The message still opens the page.

## Approaches considered

The first option was ntfy. It needs one HTTP call, but it also needs a second service and a topic, and other users of the launcher do not have it. The second option was Web Push. It is built into browsers but takes more work. The owner chose Web Push.

## Left to the builder

Exact payload JSON shape, the notification icon (use `icon-192.png`), the switch layout, and the test layout.

## Hand checks after a test build

Real delivery to the owner's Android Chrome, the `Deny` button, and the closing of the notification after an approval on another device.
