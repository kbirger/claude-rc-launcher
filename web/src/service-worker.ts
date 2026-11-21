/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { immutable } from "$app/manifest";
import { version } from "$app/env";

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
