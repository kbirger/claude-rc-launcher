import type { QueryClient } from "@tanstack/svelte-query";
import type { AllSessions, HostPart } from "../features/sessions/api";
import { ALL_SESSIONS_KEY } from "../features/sessions/queries";
import { keepStream } from "./stream";

type StreamOptions = Omit<Parameters<typeof keepStream>[0], "url" | "name" | "listeners" | "onOpen">;

/**
 * The hub sessions stream (`GET /api/sessions/events`), counted: the first `acquire` opens it, the last release closes
 * it. Each release counts once, however often it is called. The `snapshot` event (sent at each open, so also after a
 * reconnect) replaces the `["all-sessions"]` data. A `host` event replaces the rows and the status of one host.
 */
export function createSessionsStream(options: { client: QueryClient } & StreamOptions): { acquire(): () => void } {
  const { client, ...rest } = options;
  const log = options.log ?? console;
  let count = 0;
  let stop: (() => void) | undefined;

  const start = () =>
    keepStream({
      ...rest,
      url: "/api/sessions/events",
      name: "sessions stream",
      listeners: {
        snapshot(data) {
          try {
            const snap = JSON.parse(data) as AllSessions;
            if (!snap || !Array.isArray(snap.sessions) || !Array.isArray(snap.hosts)) return;
            log.info(`[claude-rc] sessions snapshot: ${snap.sessions.length} sessions, ${snap.hosts.length} hosts`);
            client.setQueryData<AllSessions>(ALL_SESSIONS_KEY, snap);
          } catch {
            // An event that does not parse is skipped. The next event brings the state.
          }
        },
        host(data) {
          try {
            const item = JSON.parse(data) as HostPart;
            if (!item?.host || !Array.isArray(item.rows)) return;
            const id = item.host.id;
            // A cold cache is left alone: every open starts with a snapshot.
            client.setQueryData<AllSessions>(ALL_SESSIONS_KEY, (cur) => {
              if (!cur) return cur;
              const known = cur.hosts.some((host) => host.id === id);
              return {
                sessions: [...cur.sessions.filter((text) => text.host.id !== id), ...item.rows],
                hosts: known ? cur.hosts.map((host) => (host.id === id ? item.host : host)) : [...cur.hosts, item.host],
              };
            });
          } catch {
            // An event that does not parse is skipped. The next event brings the state.
          }
        },
      },
    });

  return {
    acquire() {
      if (count++ === 0) stop = start();
      let released = false;

      return () => {
        if (released) return;
        released = true;

        if (--count === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}

const streams = new WeakMap<QueryClient, { acquire(): () => void }>();

/** Holds the one sessions stream of `client` until the returned release is called. A page calls it at mount. */
export function connectSessions(client: QueryClient): () => void {
  let text = streams.get(client);

  if (!text) {
    text = createSessionsStream({ client });
    streams.set(client, text);
  }

  return text.acquire();
}
