import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCreds } from "../src/creds";
import { normalizeFingerprint } from "../src/hostcmd";
import { main } from "../src/index";
import type { Env } from "../src/index";
import { defined } from "./support";

const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});
const HEX = "ab".repeat(32);
const FP = `sha256:${HEX}`;
const probeBody = {
  fingerprint: FP,
  names: ["pi.internal"],
  subject: "CN=claude-rc-node",
  not_after: "2031-01-01T00:00:00.000Z",
  pem: "PEM",
};

interface Seen {
  method: string;
  path: string;
  body: any;
}

function setup(routes: Record<string, () => Response | unknown>, typed = "") {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const parsedUrl = new URL(req.url);
      const text = await req.text();
      seen.push({ method: req.method, path: parsedUrl.pathname, body: text ? JSON.parse(text) : undefined });
      const route = routes[`${req.method} ${parsedUrl.pathname}`];
      if (!route) return Response.json({ error: "no route" }, { status: 404 });
      const item = route();
      return item instanceof Response ? item : Response.json(item);
    },
  });
  stops.push(() => server.stop(true));
  const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-host-")), "c.json");
  saveCreds(credsFile, {
    hub: `http://127.0.0.1:${server.port}`,
    issuer: "i",
    clientId: "c",
    tokenEndpoint: "t",
    idToken: "tok",
    refreshToken: "r",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const prompts: string[] = [];
  const env: Env = {
    credsFile,
    open: async () => {},
    readLine: (prompt) => Promise.resolve((prompts.push(prompt), typed)),
  };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({
    code: await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env),
  });
  return { seen, run, out, err, prompts };
}

const created = () =>
  new Response(JSON.stringify({ id: "pi", name: "pi", url: "https://pi.internal:8443", source: "managed" }), {
    status: 201,
  });

describe("normalizeFingerprint", () => {
  test("lower-cases and strips sha256: and colons", () => {
    expect(normalizeFingerprint(FP)).toBe(HEX);
    expect(normalizeFingerprint(defined(HEX.toUpperCase().match(/../g)).join(":"))).toBe(HEX);
    expect(normalizeFingerprint(`  ${FP}\n`)).toBe(HEX);
  });
});

describe("host add", () => {
  test("prompts for the fingerprint and sends the add after a match", async () => {
    const harness = setup(
      { "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created },
      HEX.toUpperCase(),
    );
    const outcome = await harness.run(
      "host",
      "add",
      "pi",
      "--url",
      "https://pi.internal:8443",
      "--name",
      "Pi",
      "--server-name",
      "pi.internal",
    );
    expect(outcome.code).toBe(0);
    expect(harness.prompts).toEqual(["Type the fingerprint that the node printed in its log: "]);
    expect(harness.seen.map((seen) => seen.path)).toEqual(["/cli/api/hosts/probe", "/cli/api/hosts"]);
    expect(harness.seen[0].body).toEqual({ url: "https://pi.internal:8443", server_name: "pi.internal" });
    expect(harness.seen[1].body).toEqual({
      id: "pi",
      name: "Pi",
      url: "https://pi.internal:8443",
      server_name: "pi.internal",
      fingerprint: FP,
    });
    const shown = harness.out.join("\n");
    expect(shown).toContain(FP);
    expect(shown).toContain("CN=claude-rc-node");
    expect(shown).toContain("added host pi");
  });

  test("--fingerprint skips the prompt", async () => {
    const harness = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created });
    expect(
      (
        await harness.run(
          "host",
          "add",
          "pi",
          "--url",
          "https://pi:1",
          "--fingerprint",
          defined(HEX.match(/../g)).join(":"),
        )
      ).code,
    ).toBe(0);
    expect(harness.prompts).toEqual([]);
    expect(harness.seen[1].body).toEqual({ id: "pi", name: undefined, url: "https://pi:1", fingerprint: FP });
  });

  test("--force is sent to the hub", async () => {
    const harness = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created });
    await harness.run("host", "add", "pi", "--url", "https://pi:1", "--fingerprint", FP, "--force");
    expect(harness.seen[1].body.force).toBe(true);
  });

  test("a mismatch sends only the probe request and exits 1", async () => {
    const harness = setup(
      { "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created },
      "ff".repeat(32),
    );
    const outcome = await harness.run("host", "add", "pi", "--url", "https://pi:1");
    expect(outcome.code).toBe(1);
    expect(harness.err[0]).toContain("fingerprint does not match");
    expect(harness.seen.map((seen) => seen.path)).toEqual(["/cli/api/hosts/probe"]);
  });

  test("a hub 502 from the test call prints the hub error", async () => {
    const harness = setup({
      "POST /cli/api/hosts/probe": () => probeBody,
      "POST /cli/api/hosts": () =>
        Response.json({ error: "host pi: rejected our credentials", host: "pi" }, { status: 502 }),
    });
    const outcome = await harness.run("host", "add", "pi", "--url", "https://pi:1", "--fingerprint", FP);
    expect(outcome.code).toBe(1);
    expect(harness.err).toEqual(["host pi: rejected our credentials"]);
  });

  test("missing id or --url is a usage error that sends nothing", async () => {
    const harness = setup({});
    expect((await harness.run("host", "add", "pi")).code).toBe(1);
    expect((await harness.run("host", "add", "--url", "https://pi:1")).code).toBe(1);
    expect((await harness.run("host")).code).toBe(1);
    expect(harness.seen).toHaveLength(0);
  });
});

describe("host remove", () => {
  test("sends DELETE and prints the id", async () => {
    const harness = setup({ "DELETE /cli/api/hosts/pi": () => new Response(null, { status: 204 }) });
    expect((await harness.run("host", "remove", "pi")).code).toBe(0);
    expect(harness.seen[0].method).toBe("DELETE");
    expect(harness.out).toEqual(["removed host pi"]);
  });
  test("a hub 409 for a config host prints its text", async () => {
    const harness = setup({
      "DELETE /cli/api/hosts/nas": () =>
        Response.json({ error: "host nas is defined in config.toml" }, { status: 409 }),
    });
    const outcome = await harness.run("host", "remove", "nas");
    expect(outcome.code).toBe(1);
    expect(harness.err[0]).toContain("config.toml");
  });
});
