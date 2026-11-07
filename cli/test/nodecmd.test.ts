import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../server/src/config";
import { saveCreds } from "../src/creds";
import { main, type Env } from "../src/index";
import { renderNodeConfig } from "../src/nodecmd";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const enrollment = { oidc: { issuer: "https://auth.example.com/o/hub/", jwks_url: "https://auth.example.com/o/hub/jwks/", audience: "hub-client", caller_claim: "sub", caller_value: "svc-1" } };
const parse = (toml: string) => parseConfig(Bun.TOML.parse(toml), { readFile: () => "x" });

describe("renderNodeConfig", () => {
  const base = { hub: "https://rc.example.com", enrollment, listen: "10.0.0.9", port: 8443, names: ["pi.internal", "10.0.0.9"] };

  test("the output is a valid node configuration with the hub's values", () => {
    const cfg = parse(renderNodeConfig({ ...base, name: "pi", roots: ["/home/pi/projects"] }));
    expect(cfg.mode).toBe("node");
    expect(cfg).toMatchObject({ name: "pi", port: 8443, host: "10.0.0.9", roots: ["/home/pi/projects"] });
    expect(cfg.node!.tls).toEqual({ stateDir: "/var/lib/claude-rc-launcher", names: ["pi.internal", "10.0.0.9"] });
    expect(cfg.node!.auth.oidc).toEqual({ jwksUrl: "https://auth.example.com/o/hub/jwks/", issuer: "https://auth.example.com/o/hub/", audience: "hub-client", callerClaim: "sub", callerValue: "svc-1" });
  });

  test("name and roots are left out when not given, so the defaults apply", () => {
    const text = renderNodeConfig(base);
    expect(text).not.toMatch(/^name\s*=/m);
    expect(text).not.toContain("[instance]");
    expect(parse(text).mode).toBe("node");
  });

  test("quotes, backslashes and newlines in values are escaped", () => {
    const cfg = parse(renderNodeConfig({ ...base, name: 'a"b\\c\nd', enrollment: { oidc: { ...enrollment.oidc, caller_value: 'x"y\\z' } } }));
    expect(cfg.name).toBe('a"b\\c\nd');
    expect(cfg.node!.auth.oidc!.callerValue).toBe('x"y\\z');
  });

  test("the header says where the file came from and has no placeholder text", () => {
    const text = renderNodeConfig(base);
    expect(text).toContain("https://rc.example.com");
    expect(text).not.toMatch(/replace-with|placeholder/i);
  });
});

type Seen = { method: string; path: string };
function setup(routes: Record<string, () => Response | unknown>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push({ method: req.method, path: u.pathname });
      const h = routes[`${req.method} ${u.pathname}`];
      if (!h) return Response.json({ error: "no route" }, { status: 404 });
      const r = h();
      return r instanceof Response ? r : Response.json(r);
    },
  });
  stops.push(() => server.stop(true));
  const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-node-")), "c.json");
  saveCreds(credsFile, { hub: `http://127.0.0.1:${server.port}`, issuer: "i", clientId: "c", tokenEndpoint: "t", idToken: "tok", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const env: Env = { credsFile, open: async () => {}, readLine: async () => "" };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({ code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env) });
  return { seen, run, out, err };
}

describe("claude-rc node config", () => {
  test("prints a valid node configuration on stdout and nothing else", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    const r = await s.run("node", "config", "--listen", "10.0.0.9", "--names", "pi.internal,10.0.0.9", "--name", "pi", "--roots", "/srv/a,/srv/b");
    expect(r.code).toBe(0);
    expect(s.out).toHaveLength(1);
    const cfg = parse(s.out[0]!);
    expect(cfg).toMatchObject({ name: "pi", port: 8443, host: "10.0.0.9", roots: ["/srv/a", "/srv/b"] });
    expect(cfg.node!.tls.names).toEqual(["pi.internal", "10.0.0.9"]);
  });

  test("--port overrides the default", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    await s.run("node", "config", "--listen", "10.0.0.9", "--names", "pi", "--port", "9443");
    expect(parse(s.out[0]!).port).toBe(9443);
  });

  test("missing or bad flags exit 1 and send nothing", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    const bad = [
      ["node", "config", "--names", "pi"],
      ["node", "config", "--listen", "10.0.0.9"],
      ["node", "config", "--listen", "10.0.0.9", "--names", ""],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--port", "99999"],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--port", "abc"],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--roots", "relative/dir"],
      ["node", "bogus"],
      ["node"],
    ];
    for (const argv of bad) expect([argv.join(" "), (await s.run(...argv)).code]).toEqual([argv.join(" "), 1]);
    expect(s.seen).toHaveLength(0);
    expect(s.out).toHaveLength(0);
  });

  test("a hub error prints its text on stderr and nothing on stdout", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => Response.json({ error: "hub_auth.oidc is not configured" }, { status: 400 }) });
    const r = await s.run("node", "config", "--listen", "10.0.0.9", "--names", "pi");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("hub_auth.oidc");
    expect(s.out).toHaveLength(0);
  });
});
