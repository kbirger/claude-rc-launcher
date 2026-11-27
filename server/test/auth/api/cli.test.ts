import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cliConfigRoute } from "../../../src/auth/api/cli";

const ISS = "https://auth.example.com/o/cli/";
const AUD = "cli-client";

describe("cliConfigRoute", () => {
  test("returns exactly issuer and client_id", async () => {
    const app = new Hono().route("/", cliConfigRoute({ issuer: ISS, clientId: AUD }));
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer: ISS, client_id: AUD });
  });
  test("the config route reports the role scope", async () => {
    const app = new Hono().route("/", cliConfigRoute({ issuer: "https://i/", clientId: "c", roleScope: "clauderc" }));
    expect(await (await app.request("/")).json()).toEqual({
      issuer: "https://i/",
      client_id: "c",
      role_scope: "clauderc",
    });
    const bare = new Hono().route("/", cliConfigRoute({ issuer: "https://i/", clientId: "c" }));
    expect(await (await bare.request("/")).json()).toEqual({ issuer: "https://i/", client_id: "c" });
  });
});
