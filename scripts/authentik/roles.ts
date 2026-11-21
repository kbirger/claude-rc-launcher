import { ApiError, textOf } from "./api";
import type { Ctx, Json } from "./api";
import type { Settings } from "./settings";

export const mappingExpression = (
  claim: string,
): string => `roles = [g.attributes.get("${claim}") for g in request.user.ak_groups.all()]
return {"${claim}": [r for r in roles if r]}`;

/** The scope mapping, the role groups, and the admin user. Older authentik versions keep the mapping under another path. */
export async function ensureRoles(
  ctx: Ctx,
  settings: Settings,
): Promise<{ mappingPk?: string; groups: Map<string, Json | undefined> }> {
  const expression = mappingExpression(settings.claim);
  let mappingsPath = "/api/v3/propertymappings/provider/scope/";
  let mapping: Json | undefined;

  try {
    mapping = await ctx.find(mappingsPath, "name", settings.mappingName);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
    mappingsPath = "/api/v3/propertymappings/scope/";
    mapping = await ctx.find(mappingsPath, "name", settings.mappingName);
  }

  let mappingPk = textOf(mapping?.pk);
  if (!mapping) {
    const made = await ctx.write(
      `create the scope mapping "${settings.mappingName}" (scope ${settings.scope})`,
      "POST",
      mappingsPath,
      { name: settings.mappingName, scope_name: settings.scope, expression },
    );
    mappingPk = textOf(made?.pk);
  } else if (mapping.expression !== expression || mapping.scope_name !== settings.scope) {
    await ctx.write(`update the scope mapping "${settings.mappingName}"`, "PATCH", `${mappingsPath}${mapping.pk}/`, {
      scope_name: settings.scope,
      expression,
    });
  } else ctx.log(`ok: the scope mapping "${settings.mappingName}" is up to date`);

  const groups = new Map<string, Json | undefined>();

  for (const group of settings.groups) {
    const found = await ctx.find("/api/v3/core/groups/?include_users=true", "name", group.name);

    if (!found) {
      groups.set(
        group.name,
        await ctx.write(
          `create the group "${group.name}" with ${settings.claim}: ${group.role}`,
          "POST",
          "/api/v3/core/groups/",
          {
            name: group.name,
            attributes: { [settings.claim]: group.role },
          },
        ),
      );
    } else if (found.attributes?.[settings.claim] !== group.role) {
      groups.set(group.name, found);
      await ctx.write(
        `set ${settings.claim}: ${group.role} on the group "${group.name}"`,
        "PATCH",
        `/api/v3/core/groups/${found.pk}/`,
        { attributes: { ...(found.attributes ?? {}), [settings.claim]: group.role } },
      );
    } else {
      groups.set(group.name, found);
      ctx.log(`ok: the group "${group.name}" has ${settings.claim}: ${group.role}`);
    }
  }

  if (settings.adminUser) {
    const user = await ctx.find("/api/v3/core/users/", "username", settings.adminUser);

    if (!user) ctx.problems.push(`user not found: ${settings.adminUser}`);
    else {
      const group = groups.get(settings.adminGroup);
      if (user.pk !== undefined && group?.users?.includes(user.pk))
        ctx.log(`ok: ${settings.adminUser} is in "${settings.adminGroup}"`);
      else if (!group && !ctx.apply)
        await ctx.write(`add ${settings.adminUser} to "${settings.adminGroup}"`, "POST", "(new group)/add_user/", {});
      else if (group)
        await ctx.write(
          `add ${settings.adminUser} to "${settings.adminGroup}"`,
          "POST",
          `/api/v3/core/groups/${group.pk}/add_user/`,
          { pk: user.pk },
        );
      else ctx.problems.push(`group not found: ${settings.adminGroup}`);
    }
  }

  return { mappingPk, groups };
}
