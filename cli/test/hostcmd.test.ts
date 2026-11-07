import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCreds } from "../src/creds";
import { normalizeFingerprint } from "../src/hostcmd";
import { main, type Env } from "../src/index";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const HEX = "ab".repeat(32);
const FP = `sha256:${HEX}`;
const probeBody = { fingerprint: FP, names: ["pi.internal"], subject: "CN=claude-rc-node", not_after: "2031-01-01T00:00:00.000Z", pem: "PEM" };

type Seen = { method: string; path: string; body: any };
function setup(routes: Record<string, () => Response | unknown>, typed = "") {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const text = await req.text();
      seen.push({ method: req.method, path: u.pathname, body: text ? JSON.parse(text) : undefined });
      const h = routes[`${req.method} ${u.pathname}`];
      if (!h) return Response.json({ error: "no route" }, { status: 404 });
      const r = h();
      return r instanceof Response ? r : Response.json(r);
    },
  });
  stops.push(() => server.stop(true));
  const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-host-")), "c.json");
  saveCreds(credsFile, { hub: `http://127.0.0.1:${server.port}`, issuer: "i", clientId: "c", tokenEndpoint: "t", idToken: "tok", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const prompts: string[] = [];
  const env: Env = { credsFile, open: async () => {}, readLine: async (p) => (prompts.push(p), typed) };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({ code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env) });
  return { seen, run, out, err, prompts };
}
const created = () => new Response(JSON.stringify({ id: "pi", name: "pi", url: "https://pi.internal:8443", source: "managed" }), { status: 201 });

describe("normalizeFingerprint", () => {
  test("lower-cases and strips sha256: and colons", () => {
    expect(normalizeFingerprint(FP)).toBe(HEX);
    expect(normalizeFingerprint(HEX.toUpperCase().match(/../g)!.join(":"))).toBe(HEX);
    expect(normalizeFingerprint(`  ${FP}\n`)).toBe(HEX);
  });
});

describe("host add", () => {
  test("prompts for the fingerprint and sends the add after a match", async () => {
    const s = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created }, HEX.toUpperCase());
    const r = await s.run("host", "add", "pi", "--url", "https://pi.internal:8443", "--name", "Pi", "--server-name", "pi.internal");
    expect(r.code).toBe(0);
    expect(s.prompts).toEqual(["Type the fingerprint that the node printed in its log: "]);
    expect(s.seen.map((x) => x.path)).toEqual(["/cli/api/hosts/probe", "/cli/api/hosts"]);
    expect(s.seen[0]!.body).toEqual({ url: "https://pi.internal:8443", server_name: "pi.internal" });
    expect(s.seen[1]!.body).toEqual({ id: "pi", name: "Pi", url: "https://pi.internal:8443", server_name: "pi.internal", fingerprint: FP });
    const shown = s.out.join("\n");
    expect(shown).toContain(FP);
    expect(shown).toContain("CN=claude-rc-node");
    expect(shown).toContain("added host pi");
  });

  test("--fingerprint skips the prompt", async () => {
    const s = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created });
    expect((await s.run("host", "add", "pi", "--url", "https://pi:1", "--fingerprint", HEX.match(/../g)!.join(":"))).code).toBe(0);
    expect(s.prompts).toEqual([]);
    expect(s.seen[1]!.body).toEqual({ id: "pi", name: undefined, url: "https://pi:1", fingerprint: FP });
  });

  test("--force is sent to the hub", async () => {
    const s = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created });
    await s.run("host", "add", "pi", "--url", "https://pi:1", "--fingerprint", FP, "--force");
    expect(s.seen[1]!.body.force).toBe(true);
  });

  test("a mismatch sends only the probe request and exits 1", async () => {
    const s = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": created }, "ff".repeat(32));
    const r = await s.run("host", "add", "pi", "--url", "https://pi:1");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("fingerprint does not match");
    expect(s.seen.map((x) => x.path)).toEqual(["/cli/api/hosts/probe"]);
  });

  test("a hub 502 from the test call prints the hub error", async () => {
    const s = setup({ "POST /cli/api/hosts/probe": () => probeBody, "POST /cli/api/hosts": () => Response.json({ error: "host pi: rejected our credentials", host: "pi" }, { status: 502 }) });
    const r = await s.run("host", "add", "pi", "--url", "https://pi:1", "--fingerprint", FP);
    expect(r.code).toBe(1);
    expect(s.err).toEqual(["host pi: rejected our credentials"]);
  });

  test("missing id or --url is a usage error that sends nothing", async () => {
    const s = setup({});
    expect((await s.run("host", "add", "pi")).code).toBe(1);
    expect((await s.run("host", "add", "--url", "https://pi:1")).code).toBe(1);
    expect((await s.run("host")).code).toBe(1);
    expect(s.seen).toHaveLength(0);
  });
});

describe("host remove", () => {
  test("sends DELETE and prints the id", async () => {
    const s = setup({ "DELETE /cli/api/hosts/pi": () => new Response(null, { status: 204 }) });
    expect((await s.run("host", "remove", "pi")).code).toBe(0);
    expect(s.seen[0]!.method).toBe("DELETE");
    expect(s.out).toEqual(["removed host pi"]);
  });
  test("a hub 409 for a config host prints its text", async () => {
    const s = setup({ "DELETE /cli/api/hosts/nas": () => Response.json({ error: "host nas is defined in config.toml" }, { status: 409 }) });
    const r = await s.run("host", "remove", "nas");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("config.toml");
  });
});
