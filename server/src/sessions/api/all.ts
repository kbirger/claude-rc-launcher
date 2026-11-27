/*
 * The hub list of all sessions: `GET /api/sessions`. It answers from the hub store (SessionsStore.ts), which the hub's own
 * index and the node streams keep up to date. It calls no node and has no time limit. The hub does not sort.
 */
import { Hono } from "hono";
import type { SessionsStore } from "../SessionsStore";

export function allSessionsApi(options: { store: Pick<SessionsStore, "answer"> }): Hono {
  const app = new Hono();
  app.get("/", (context) => context.json(options.store.answer()));
  return app;
}
