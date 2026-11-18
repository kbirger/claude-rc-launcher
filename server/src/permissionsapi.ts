/*
 * The HTTP routes that show and edit the permission rules, and show the blocked tool calls. They are a thin layer over
 * ClaudeSettings (settingsfile.ts) and Session.permissions, Session.settings and Session.blocked (sessioncatalog.ts).
 * See docs/superpowers/specs/2026-11-14-permissions-design.md.
 *
 * Mount at `/instances/:id`:
 *   GET /permissions                 the user settings file of the instance (the home folder of its user).
 *   GET /sessions/:sid/permissions   every settings layer that applies to the session, highest precedence first.
 *   GET /sessions/:sid/blocked       the blocked tool calls of the session transcript, newest first.
 *   POST|DELETE /permissions/rules                 add or remove one rule in the user file.
 *   POST|DELETE /sessions/:sid/permissions/rules   the same in the user, project or local file of the session.
 * The body of an edit is { scope, list, rule, expectedHash } and, on a session route, an optional nudge: true. The nudge
 * is for an add to the allow list only (a remove or another list gives 400). After the write the node tells the live
 * session to try again, and the answer is the updated Layer plus { nudge: result }. The answer is the updated Layer. A
 * failed edit is { error } with the status of its SettingsError. Every edit writes one audit line (caller, instance,
 * scope, action, list, rule, status, nudge). The nudge field is off, sent, or the reason it was not sent. The rule is
 * written with JSON.stringify. The line never holds file content or text of a blocked call.
 */
import { Hono, type Context } from "hono";
import { HttpError, type Instances } from "./instances";
import { isObject, readJson } from "./requests";
import { sessionLookup } from "./sessionapi";
import type { SessionCatalog } from "./sessioncatalog";
import { nudge as realNudge, nudgeMessage, type NudgeResult } from "./nudge";
import { checkRule, ClaudeSettings, SettingsError, type LayerScope } from "./settingsfile";
import type { RuleList } from "./permrules";

export type PermissionsApiDeps = {
  instances: Instances;
  sessions: SessionCatalog;
  /** Where the audit lines go (tests replace it). Defaults to console.log. */
  log?: (line: string) => void;
  /** Tests: replace the root check of the writer. */
  isRoot?: () => boolean;
  /** Tests: replace the nudge (the send to the live session). */
  nudge?: typeof realNudge;
};

export type RuleEdit = { scope: LayerScope; list: RuleList; rule: string; expectedHash: string | null; nudge: boolean };

/**
 * The body of an edit. `scopes` is the set that the route accepts. The rule gets the same checks as in SettingsFile
 * (list, length, control characters, shape), so a bad rule is refused before anything is forwarded.
 */
export function parseRuleEdit<S extends LayerScope>(body: unknown, scopes: readonly S[], o: { allowNudge?: boolean; remove?: boolean } = {}): RuleEdit & { scope: S } {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  const { scope, list, rule, expectedHash } = body;
  const nudge = body.nudge === undefined ? false : body.nudge;
  if (typeof scope !== "string" || !(scopes as readonly string[]).includes(scope)) throw new HttpError(400, `scope must be one of ${scopes.join(", ")}`);
  if (typeof list !== "string") throw new HttpError(400, "list must be allow, ask or deny");
  if (typeof rule !== "string") throw new HttpError(400, "rule must be a string");
  if (expectedHash !== null && typeof expectedHash !== "string") throw new HttpError(400, "expectedHash must be a string or null");
  if (typeof nudge !== "boolean") throw new HttpError(400, "nudge must be true or false");
  if (nudge && !o.allowNudge) throw new HttpError(400, "nudge needs a session");
  if (nudge && o.remove) throw new HttpError(400, "nudge is not for a remove");
  if (nudge && list !== "allow") throw new HttpError(400, "nudge needs the allow list");
  try {
    checkRule(list, rule);
  } catch (e) {
    if (e instanceof SettingsError) throw new HttpError(400, e.message);
    throw e;
  }
  return { scope: scope as S, list: list as RuleList, rule, expectedHash, nudge };
}

/** The scopes that the node reads from a body. Whether the file can be written is decided by SettingsFile (managed is 403). */
const NODE_SCOPES: readonly LayerScope[] = ["user", "project", "local", "legacy-local", "managed"];

export function permissionsApi(deps: PermissionsApiDeps): Hono {
  const { home, sessionOf } = sessionLookup(deps.instances, deps.sessions);
  const log = deps.log ?? ((l: string) => console.log(l));
  const rootOpt = deps.isRoot ? { isRoot: deps.isRoot } : {};
  const r = new Hono();

  /**
   * Runs one edit and writes its audit line. The line is written once the body names a scope, list and rule as strings,
   * also when the edit fails. A SettingsError or HttpError becomes its status with { error }.
   */
  async function edit(c: Context, action: "add" | "remove", scopes: readonly LayerScope[], fileOf: (scope: LayerScope) => Promise<ReturnType<ClaudeSettings["file"]>>, allowNudge = false) {
    const body = await readJson(c);
    const f = isObject(body) ? body : {};
    // A request value is printed bare only when it is in its known set, else as "?". The rule is JSON-quoted. The caller
    // comes from the login, and is JSON-quoted when it has anything but plain name characters.
    const known = (v: unknown, set: readonly string[]) => (typeof v === "string" && set.includes(v) ? v : "?");
    const rawCaller = String(c.get("caller" as never) ?? "unknown");
    const caller = /^[\w.@:-]+$/.test(rawCaller) ? rawCaller : JSON.stringify(rawCaller);
    const rawId = c.req.param("id") ?? "";
    const instance = /^[0-9a-f]{12}$/.test(rawId) ? rawId : "?";
    let status = 500;
    let nudgeValue = "off";
    try {
      const e = parseRuleEdit(body, scopes, { allowNudge, remove: action === "remove" });
      const file = await fileOf(e.scope);
      if (!file) throw e.scope === "managed" || e.scope === "legacy-local" ? new HttpError(403, `the ${e.scope} settings file is read-only`) : new HttpError(404, "settings file not found");
      const layer = action === "add" ? await file.addRule({ list: e.list, raw: e.rule, expectedHash: e.expectedHash }) : await file.removeRule({ list: e.list, raw: e.rule, expectedHash: e.expectedHash ?? "" });
      status = 200;
      if (action === "add" && e.nudge) {
        const result = await runNudge(c, e, layer.path);
        nudgeValue = result.sent ? "sent" : result.reason;
        return c.json({ ...layer, nudge: result });
      }
      return c.json(layer);
    } catch (err) {
      if (err instanceof SettingsError || err instanceof HttpError) {
        status = err.status;
        return c.json({ error: err.message }, err.status as 400);
      }
      throw err;
    } finally {
      log(`audit caller=${caller} instance=${instance} scope=${known(f.scope, NODE_SCOPES)} action=${action} list=${known(f.list, ["allow", "ask", "deny"])} rule=${JSON.stringify(typeof f.rule === "string" ? f.rule : "?")} status=${status} nudge=${nudgeValue}`);
    }
  }
  /** Sends the nudge after a successful add. Any failure, a throw included, is send_failed and never changes the add. */
  async function runNudge(c: Context, e: RuleEdit, path: string | null): Promise<NudgeResult> {
    try {
      if (path === null) return { sent: false, reason: "send_failed" };
      const h = await home(c);
      const session = await sessionOf(c);
      return await (deps.nudge ?? realNudge)({ home: h.home, sessionId: session.id, message: nudgeMessage({ list: e.list, path }), ...(h.identity ? { identity: h.identity } : {}) });
    } catch {
      return { sent: false, reason: "send_failed" };
    }
  }
  const userFile = async (c: Context) => {
    const h = await home(c);
    return ClaudeSettings.forHome({ home: h.home, ownerUid: h.identity?.uid, ...rootOpt }).file("user");
  };
  const sessionFile = async (c: Context, scope: LayerScope) => {
    const h = await home(c);
    const session = await sessionOf(c);
    return (await session.settings({ ownerUid: h.identity?.uid, ...rootOpt })).file(scope);
  };
  r.post("/permissions/rules", (c) => edit(c, "add", ["user"], () => userFile(c)));
  r.delete("/permissions/rules", (c) => edit(c, "remove", ["user"], () => userFile(c)));
  r.post("/sessions/:sid/permissions/rules", (c) => edit(c, "add", NODE_SCOPES, (s) => sessionFile(c, s), true));
  r.delete("/sessions/:sid/permissions/rules", (c) => edit(c, "remove", NODE_SCOPES, (s) => sessionFile(c, s), true));

  r.get("/permissions", async (c) => {
    const h = await home(c);
    return c.json(await ClaudeSettings.forHome({ home: h.home, ownerUid: h.identity?.uid, ...rootOpt }).layers());
  });

  r.get("/sessions/:sid/permissions", async (c) => {
    const h = await home(c);
    const session = await sessionOf(c);
    return c.json(await session.permissions({ ownerUid: h.identity?.uid, ...rootOpt }));
  });

  r.get("/sessions/:sid/blocked", async (c) => c.json(await (await sessionOf(c)).blocked()));

  return r;
}
