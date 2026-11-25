/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { immutable } from "$app/manifest";
import { version } from "$app/env";
import { handleClick, notificationOptions, parsePush, type ClickData } from "#lib/features/push/worker";

declare const self: ServiceWorkerGlobalScope;

// Only the hashed build files are cached. Pages and API calls always go to the network, because the hub puts every
// page behind login and the data is live: a cached page could be a login redirect or stale session data.
const CACHE = `app-${version}`;
const BUILD = immutable.map((immutableItem) => `/${immutableItem.path}`);
const ASSETS = new Set(BUILD);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((item) => item.addAll(BUILD))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !ASSETS.has(url.pathname)) return;
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});

// Push: the hub sends one JSON message for each SSH request. Chrome requires a visible notification for every push,
// so a message that cannot be read still shows a generic one.
self.addEventListener("push", (event) => {
  const message = parsePush(event.data?.text() ?? "");
  const show = message
    ? self.registration.showNotification(message.title, notificationOptions(message))
    : self.registration.showNotification("SSH access requested", {
        tag: "ssh-request",
        body: "Open the SSH page to answer.",
        icon: "/icon-192.png",
        data: { url: "/ssh" },
      });
  event.waitUntil(show);
});

async function focusOrOpen(url: string) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const known = windows.find((item) => new URL(item.url).pathname === new URL(url, self.location.origin).pathname);
  if (known) await known.focus();
  else await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as ClickData | undefined;
  event.waitUntil(
    handleClick(
      event.action,
      { url: data?.url ?? "/ssh", grantId: data?.grantId },
      {
        // Same call as `denyGrant` in the page: JSON content type, and the cookie goes along on a same-origin fetch.
        deny: (grantId) =>
          fetch(`/api/ssh/grants/${encodeURIComponent(grantId)}/deny`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
          }),
        open: focusOrOpen,
      },
    ),
  );
});
