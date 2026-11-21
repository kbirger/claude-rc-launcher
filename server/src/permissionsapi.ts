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
import { Hono } from "hono";
import type { Context } from "hono";
import { HttpError } from "./instances";
import type { Instances } from "./instances";
import { nudge as realNudge, nudgeMessage } from "./nudge";
import type { NudgeResult } from "./nudge";
import type { RuleList } from "./permrules";
import { isObject, readJson } from "./requests";
import { sessionLookup } from "./sessionapi";
import type { SessionCatalog } from "./sessioncatalog";
import { checkRule, ClaudeSettings, SettingsError } from "./settingsfile";
import type { LayerScope } from "./settingsfile";

export interface PermissionsApiDeps {
  instances: Instances;
  sessions: SessionCatalog;
  /** Where the audit lines go (tests replace it). Defaults to console.log. */
  log?: (line: string) => void;
  /** Tests: replace the root check of the writer. */
  isRoot?: () => boolean;
  /** Tests: replace the nudge (the send to the live session). */
  nudge?: typeof realNudge;
}

export interface RuleEdit {
  scope: LayerScope;
  list: RuleList;
  rule: string;
  expectedHash: string | null;
  nudge: boolean;
}

/**
 * The body of an edit. `scopes` is the set that the route accepts. The rule gets the same checks as in SettingsFile
 * (list, length, control characters, shape), so a bad rule is refused before anything is forwarded.
 */
export function parseRuleEdit<Item extends LayerScope>(
  body: unknown,
  scopes: readonly Item[],
  options: { allowNudge?: boolean; remove?: boolean } = {},
): RuleEdit & { scope: Item } {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  const { scope, list, rule, expectedHash } = body;
  const nudge = body.nudge === undefined ? false : body.nudge;
  if (typeof scope !== "string" || !(scopes as readonly string[]).includes(scope))
    throw new HttpError(400, `scope must be one of ${scopes.join(", ")}`);
  if (typeof list !== "string") throw new HttpError(400, "list must be allow, ask or deny");
  if (typeof rule !== "string") throw new HttpError(400, "rule must be a string");
  if (expectedHash !== null && typeof expectedHash !== "string")
    throw new HttpError(400, "expectedHash must be a string or null");
  if (typeof nudge !== "boolean") throw new HttpError(400, "nudge must be true or false");
  if (nudge && !options.allowNudge) throw new HttpError(400, "nudge needs a session");
  if (nudge && options.remove) throw new HttpError(400, "nudge is not for a remove");
  if (nudge && list !== "allow") throw new HttpError(400, "nudge needs the allow list");

  try {
    checkRule(list, rule);
  } catch (error) {
    if (error instanceof SettingsError) throw new HttpError(400, error.message);
    throw error;
  }

  return { scope: scope as Item, list: list as RuleList, rule, expectedHash, nudge };
}

/** The scopes that the node reads from a body. Whether the file can be written is decided by SettingsFile (managed is 403). */
const NODE_SCOPES: readonly LayerScope[] = ["user", "project", "local", "legacy-local", "managed"];

export function permissionsApi(deps: PermissionsApiDeps): Hono {
  const { home, sessionOf } = sessionLookup(deps.instances, deps.sessions);
  const log =
    deps.log ??
    ((item: string) => {
      console.log(item);
    });
  const rootOpt = deps.isRoot ? { isRoot: deps.isRoot } : {};
  const hono = new Hono();

  /**
   * Runs one edit and writes its audit line. The line is written once the body names a scope, list and rule as strings,
   * also when the edit fails. A SettingsError or HttpError becomes its status with { error }.
   */
  async function edit(
    context: Context,
    action: "add" | "remove",
    scopes: readonly LayerScope[],
    fileOf: (scope: LayerScope) => Promise<ReturnType<ClaudeSettings["file"]>>,
    allowNudge = false,
  ) {
    const body = await readJson(context);
    const record = isObject(body) ? body : {};
    // A request value is printed bare only when it is in its known set, else as "?". The rule is JSON-quoted. The caller
    // comes from the login, and is JSON-quoted when it has anything but plain name characters.
    const known = (value: unknown, set: readonly string[]) =>
      typeof value === "string" && set.includes(value) ? value : "?";
    const rawCaller = String(context.get("caller" as never) ?? "unknown");
    const caller = /^[\w.@:-]+$/.test(rawCaller) ? rawCaller : JSON.stringify(rawCaller);
    const rawId = context.req.param("id") ?? "";
    const instance = /^[0-9a-f]{12}$/.test(rawId) ? rawId : "?";
    let status = 500;
    let nudgeValue = "off";

    try {
      const ruleEdit = parseRuleEdit(body, scopes, { allowNudge, remove: action === "remove" });
      const file = await fileOf(ruleEdit.scope);
      if (!file)
        throw ruleEdit.scope === "managed" || ruleEdit.scope === "legacy-local"
          ? new HttpError(403, `the ${ruleEdit.scope} settings file is read-only`)
          : new HttpError(404, "settings file not found");
      const layer =
        action === "add"
          ? await file.addRule({ list: ruleEdit.list, raw: ruleEdit.rule, expectedHash: ruleEdit.expectedHash })
          : await file.removeRule({
              list: ruleEdit.list,
              raw: ruleEdit.rule,
              expectedHash: ruleEdit.expectedHash ?? "",
            });
      status = 200;

      if (action === "add" && ruleEdit.nudge) {
        const result = await runNudge(context, ruleEdit, layer.path);
        nudgeValue = result.sent ? "sent" : result.reason;
        return context.json({ ...layer, nudge: result });
      }

      return context.json(layer);
    } catch (err) {
      if (err instanceof SettingsError || err instanceof HttpError) {
        status = err.status;
        return context.json({ error: err.message }, err.status as 400);
      }

      throw err;
    } finally {
      log(
        `audit caller=${caller} instance=${instance} scope=${known(record.scope, NODE_SCOPES)} action=${action} list=${known(record.list, ["allow", "ask", "deny"])} rule=${JSON.stringify(typeof record.rule === "string" ? record.rule : "?")} status=${status} nudge=${nudgeValue}`,
      );
    }
  }

  /** Sends the nudge after a successful add. Any failure, a throw included, is send_failed and never changes the add. */
  async function runNudge(context: Context, ruleEdit: RuleEdit, path: string | null): Promise<NudgeResult> {
    try {
      if (path === null) return { sent: false, reason: "send_failed" };
      const target = await home(context);
      const session = await sessionOf(context);
      return await (deps.nudge ?? realNudge)({
        home: target.home,
        sessionId: session.id,
        message: nudgeMessage({ list: ruleEdit.list, path }),
        ...(target.identity ? { identity: target.identity } : {}),
      });
    } catch {
      return { sent: false, reason: "send_failed" };
    }
  }

  const userFile = async (context: Context) => {
    const target = await home(context);
    return ClaudeSettings.forHome({ home: target.home, ownerUid: target.identity?.uid, ...rootOpt }).file("user");
  };

  const sessionFile = async (context: Context, scope: LayerScope) => {
    const target = await home(context);
    const session = await sessionOf(context);
    return (await session.settings({ ownerUid: target.identity?.uid, ...rootOpt })).file(scope);
  };

  hono.post("/permissions/rules", (context) => edit(context, "add", ["user"], () => userFile(context)));
  hono.delete("/permissions/rules", (context) => edit(context, "remove", ["user"], () => userFile(context)));
  hono.post("/sessions/:sid/permissions/rules", (context) =>
    edit(context, "add", NODE_SCOPES, (layerScope) => sessionFile(context, layerScope), true),
  );
  hono.delete("/sessions/:sid/permissions/rules", (context) =>
    edit(context, "remove", NODE_SCOPES, (layerScope) => sessionFile(context, layerScope), true),
  );

  hono.get("/permissions", async (context) => {
    const target = await home(context);
    return context.json(
      await ClaudeSettings.forHome({ home: target.home, ownerUid: target.identity?.uid, ...rootOpt }).layers(),
    );
  });

  hono.get("/sessions/:sid/permissions", async (context) => {
    const target = await home(context);
    const session = await sessionOf(context);
    return context.json(await session.permissions({ ownerUid: target.identity?.uid, ...rootOpt }));
  });

  hono.get("/sessions/:sid/blocked", async (context) => context.json(await (await sessionOf(context)).blocked()));

  return hono;
}
