/*
 * The HTTP routes that show the permission rules and the blocked tool calls. They are a thin layer over
 * ClaudeSettings (settingsfile.ts) and Session.permissions and Session.blocked (sessioncatalog.ts). Phase 1 only reads.
 * See docs/superpowers/specs/2026-11-14-permissions-design.md.
 *
 * Mount at `/instances/:id`:
 *   GET /permissions                 the user settings file of the instance (the home folder of its user).
 *   GET /sessions/:sid/permissions   every settings layer that applies to the session, highest precedence first.
 *   GET /sessions/:sid/blocked       the blocked tool calls of the session transcript, newest first.
 */
import { Hono } from "hono";
import type { Instances } from "./instances";
import { sessionLookup } from "./sessionapi";
import type { SessionCatalog } from "./sessioncatalog";
import { ClaudeSettings } from "./settingsfile";

export type PermissionsApiDeps = { instances: Instances; sessions: SessionCatalog };

export function permissionsApi(deps: PermissionsApiDeps): Hono {
  const { home, sessionOf } = sessionLookup(deps.instances, deps.sessions);
  const r = new Hono();

  r.get("/permissions", async (c) => {
    const h = await home(c);
    return c.json(await ClaudeSettings.forHome({ home: h.home, ownerUid: h.identity?.uid }).layers());
  });

  r.get("/sessions/:sid/permissions", async (c) => {
    const h = await home(c);
    const session = await sessionOf(c);
    return c.json(await session.permissions({ ownerUid: h.identity?.uid }));
  });

  r.get("/sessions/:sid/blocked", async (c) => c.json(await (await sessionOf(c)).blocked()));

  return r;
}
