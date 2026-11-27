import type { Context } from "hono";
import { HttpError } from "./HttpError";

/**
 * Reading and validating request bodies. The local routes (`app.ts`), the routes that forward to a node
 * (`hosts/api/forward.ts`) and the host admin API (`hosts/api/admin.ts`) all use this module, so a local host and a remote host accept
 * the same input and a new field is added in one place.
 */

/** Own property test. It works as `Object.hasOwn`, which the lint rules for supported Node versions do not accept. */
export const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function readJson(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export async function readObject(context: Context): Promise<Record<string, unknown>> {
  const body = await readJson(context);
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  return body;
}
