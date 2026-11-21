import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { onError } from "../src/app";
import { enrollmentApi } from "../src/enrollment";

function get(hubKeys: string[]) {
  const hono = new Hono();
  hono.route("/node-enrollment", enrollmentApi({ hubKeys }));
  hono.onError(onError);
  return hono.request("/node-enrollment");
}

describe("GET /node-enrollment", () => {
  test("returns the hub public key and nothing else, with no other configuration", async () => {
    const response = await get(["PUB1"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hub_keys: [{ public_key: "PUB1" }] });
  });

  test("lists every key it is given", async () => {
    expect(await (await get(["A", "B"])).json()).toEqual({ hub_keys: [{ public_key: "A" }, { public_key: "B" }] });
  });
});
