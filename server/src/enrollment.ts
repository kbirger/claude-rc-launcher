import { Hono } from "hono";

/** What a node needs to accept this hub: the hub's public key. Nothing else is reported. */
export function enrollmentApi(o: { hubKeys: string[] }): Hono {
  const r = new Hono();
  r.get("/", (c) => c.json({ hub_keys: o.hubKeys.map((public_key) => ({ public_key })) }));
  return r;
}
