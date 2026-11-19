/*
 * The hub list of all sessions: `GET /api/sessions`. The hub asks its own node and every host in the registry for
 * `GET /api/sessions` (each node answers from its cached list, see sessionindex.ts) and merges the answers. A node that
 * does not answer, or is too old to have the route, does not fail the call: its status is in `hosts`. The hub does not sort.
 */
import { Hono } from "hono";
import type { Config } from "./config";
import { HostError } from "./hostclient";
import type { HostRegistry } from "./hostregistry";
import { OFFLINE } from "./hosts";
import type { SessionRow, SessionsAnswer } from "./sessionindex";

export type HostSessionsStatus = { id: string; name: string; status: "ok" | "offline" | "error" | "unsupported"; error?: string; scannedAt?: string };
export type HubSession = SessionRow & { host: { id: string; name: string } };
export type HubSessions = { sessions: HubSession[]; hosts: HostSessionsStatus[] };

const isAnswer = (b: unknown): b is SessionsAnswer =>
  typeof b === "object" && b !== null && Array.isArray((b as SessionsAnswer).sessions) && typeof (b as SessionsAnswer).scannedAt === "string";

type Part = { rows: HubSession[]; host: HostSessionsStatus };

/** What one node answered, as a part of the merged answer. */
function partOf(host: { id: string; name: string }, status: number, body: unknown): Part {
  if (status === 404 || status === 501) return { rows: [], host: { ...host, status: "unsupported" } };
  if (status === 200 && isAnswer(body)) return { rows: body.sessions.map((s) => ({ ...s, host })), host: { ...host, status: "ok", scannedAt: body.scannedAt } };
  const text = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "bad response";
  return { rows: [], host: { ...host, status: "error", error: text } };
}

export function allSessionsApi(o: { cfg: Config; local: Hono; registry: HostRegistry; timeoutMs?: number }): Hono {
  // The limit of the host probe: a node answers from its copy, so a node that needs longer is not answering.
  const timeoutMs = o.timeoutMs ?? 3_000;
  const app = new Hono();
  app.get("/", async (c) => {
    const local = { id: "local", name: o.cfg.name };
    const localPart = async (): Promise<Part> => {
      try {
        const res = await o.local.request("/sessions");
        return partOf(local, res.status, await res.json().catch(() => undefined));
      } catch (e) {
        return { rows: [], host: { ...local, status: "error", error: e instanceof Error ? e.message : String(e) } };
      }
    };
    const remotePart = async ({ host: h, client }: ReturnType<HostRegistry["list"]>[number]): Promise<Part> => {
      const host = { id: h.id, name: h.name };
      try {
        const r = await client.call("GET", "/api/sessions", { timeoutMs });
        return partOf(host, r.status, r.body);
      } catch (e) {
        if (e instanceof HostError) return { rows: [], host: { ...host, status: OFFLINE.includes(e.reason) ? "offline" : "error", error: e.reason } };
        return { rows: [], host: { ...host, status: "error", error: "bad response" } };
      }
    };
    const parts = await Promise.all([localPart(), ...o.registry.list().map(remotePart)]);
    return c.json({ sessions: parts.flatMap((p) => p.rows), hosts: parts.map((p) => p.host) } satisfies HubSessions);
  });
  return app;
}
