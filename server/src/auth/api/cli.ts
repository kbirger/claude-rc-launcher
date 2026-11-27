import { Hono } from "hono";

/** Public values that the CLI needs to start a login. Contains no secret. */
export function cliConfigRoute(options: { issuer: string; clientId: string; roleScope?: string }): Hono {
  const hono = new Hono();
  hono.get("/", (context) =>
    context.json({
      issuer: options.issuer,
      client_id: options.clientId,
      ...(options.roleScope ? { role_scope: options.roleScope } : {}),
    }),
  );
  return hono;
}
