import { HttpError } from "../shared/HttpError";
import { isObject } from "../shared/requests";
import type { RuleList } from "./permrules";
import { checkRule, SettingsError } from "./SettingsFile";
import type { LayerScope } from "./SettingsFile";

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
