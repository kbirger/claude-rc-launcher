import { Hono } from "hono";

/** What a node needs to accept this hub: the hub's public key. Nothing else is reported. */
export function enrollmentApi(options: { hubKeys: string[] }): Hono {
  const hono = new Hono();
  hono.get("/", (context) => context.json({ hub_keys: options.hubKeys.map((public_key) => ({ public_key })) }));
  return hono;
}
