import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { onError } from "../src/app";
import { enrollmentApi } from "../src/enrollment";

function get(hubKeys: string[]) {
  const a = new Hono();
  a.route("/node-enrollment", enrollmentApi({ hubKeys }));
  a.onError(onError);
  return a.request("/node-enrollment");
}

describe("GET /node-enrollment", () => {
  test("returns the hub public key and nothing else, with no other configuration", async () => {
    const r = await get(["PUB1"]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ hub_keys: [{ public_key: "PUB1" }] });
  });

  test("lists every key it is given", async () => {
    expect(await (await get(["A", "B"])).json()).toEqual({ hub_keys: [{ public_key: "A" }, { public_key: "B" }] });
  });
});
