import { ApiError, type Ctx, type Json } from "./api";
import type { Settings } from "./settings";

export const mappingExpression = (claim: string): string => `roles = [g.attributes.get("${claim}") for g in request.user.ak_groups.all()]
return {"${claim}": [r for r in roles if r]}`;

/** The scope mapping, the role groups, and the admin user. Older authentik versions keep the mapping under another path. */
export async function ensureRoles(ctx: Ctx, s: Settings): Promise<{ mappingPk?: string; groups: Map<string, Json | undefined> }> {
  const expression = mappingExpression(s.claim);
  let mappingsPath = "/api/v3/propertymappings/provider/scope/";
  let mapping: Json | undefined;
  try {
    mapping = await ctx.find(mappingsPath, "name", s.mappingName);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    mappingsPath = "/api/v3/propertymappings/scope/";
    mapping = await ctx.find(mappingsPath, "name", s.mappingName);
  }
  let mappingPk: string | undefined = mapping?.pk;
  if (!mapping) {
    const made = await ctx.write(`create the scope mapping "${s.mappingName}" (scope ${s.scope})`, "POST", mappingsPath, { name: s.mappingName, scope_name: s.scope, expression });
    mappingPk = made?.pk;
  } else if (mapping.expression !== expression || mapping.scope_name !== s.scope) {
    await ctx.write(`update the scope mapping "${s.mappingName}"`, "PATCH", `${mappingsPath}${mapping.pk}/`, { scope_name: s.scope, expression });
  } else ctx.log(`ok: the scope mapping "${s.mappingName}" is up to date`);

  const groups = new Map<string, Json | undefined>();
  for (const g of s.groups) {
    const found = await ctx.find("/api/v3/core/groups/?include_users=true", "name", g.name);
    if (!found) {
      groups.set(g.name, await ctx.write(`create the group "${g.name}" with ${s.claim}: ${g.role}`, "POST", "/api/v3/core/groups/", { name: g.name, attributes: { [s.claim]: g.role } }));
    } else if (found.attributes?.[s.claim] !== g.role) {
      groups.set(g.name, found);
      await ctx.write(`set ${s.claim}: ${g.role} on the group "${g.name}"`, "PATCH", `/api/v3/core/groups/${found.pk}/`, { attributes: { ...(found.attributes ?? {}), [s.claim]: g.role } });
    } else {
      groups.set(g.name, found);
      ctx.log(`ok: the group "${g.name}" has ${s.claim}: ${g.role}`);
    }
  }

  if (s.adminUser) {
    const user = await ctx.find("/api/v3/core/users/", "username", s.adminUser);
    if (!user) ctx.problems.push(`user not found: ${s.adminUser}`);
    else {
      const group = groups.get(s.adminGroup);
      if (group?.users?.includes(user.pk)) ctx.log(`ok: ${s.adminUser} is in "${s.adminGroup}"`);
      else if (!group && !ctx.apply) await ctx.write(`add ${s.adminUser} to "${s.adminGroup}"`, "POST", "(new group)/add_user/", {});
      else if (group) await ctx.write(`add ${s.adminUser} to "${s.adminGroup}"`, "POST", `/api/v3/core/groups/${group.pk}/add_user/`, { pk: user.pk });
      else ctx.problems.push(`group not found: ${s.adminGroup}`);
    }
  }
  return { mappingPk, groups };
}
