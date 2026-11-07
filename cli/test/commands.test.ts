import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCreds, type Credentials } from "../src/creds";
import { main, type Env } from "../src/index";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-cmd-"));
const ID = "0123456789ab";

type Seen = { method: string; path: string; body: string };
function setup(routes: Record<string, () => Response | unknown> = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const key = `${req.method} ${u.pathname}`;
      seen.push({ method: req.method, path: u.pathname + u.search, body: await req.text() });
      const h = routes[key];
      if (!h) return Response.json({ error: `no route ${key}` }, { status: 404 });
      const r = h();
      return r instanceof Response ? r : Response.json(r);
    },
  });
  stops.push(() => server.stop(true));
  const credsFile = path.join(tmp(), "credentials.json");
  const creds: Credentials = { hub: `http://127.0.0.1:${server.port}`, issuer: "i", clientId: "c", tokenEndpoint: "t", idToken: "tok", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  saveCreds(credsFile, creds);
  const env: Env = { credsFile, open: async () => {}, readLine: async () => "" };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({ code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env), out, err });
  return { seen, run, out, err, env, credsFile };
}

describe("commands", () => {
  test("hosts prints a table and --json prints the response", async () => {
    const hosts = [{ id: "local", name: "box", status: "ok" }, { id: "nas", name: "NAS", status: "offline", error: "timeout", source: "config" }];
    const s = setup({ "GET /cli/api/hosts": () => hosts });
    expect((await s.run("hosts")).code).toBe(0);
    expect(s.out.join("\n")).toMatch(/ID\s+NAME\s+STATUS/);
    expect(s.out.join("\n")).toMatch(/nas\s+NAS\s+offline: timeout/);
    s.out.length = 0;
    await s.run("hosts", "--json");
    expect(JSON.parse(s.out.join("\n"))).toEqual(hosts);
  });

  test("list uses the host from --host and defaults to local", async () => {
    const inst = [{ id: ID, name: "n", state: "active", path: "/srv/p", startedAt: null }];
    const s = setup({ "GET /cli/api/hosts/local/instances": () => inst, "GET /cli/api/hosts/nas/instances": () => inst });
    await s.run("list");
    await s.run("list", "--host", "nas");
    expect(s.seen.map((r) => r.path)).toEqual(["/cli/api/hosts/local/instances", "/cli/api/hosts/nas/instances"]);
    expect(s.out.join("\n")).toMatch(new RegExp(`${ID}\\s+n\\s+active\\s+/srv/p`));
  });

  test("start sends path and name and prints the new id", async () => {
    const s = setup({ "POST /cli/api/hosts/local/instances": () => new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/p", state: "active", startedAt: null }), { status: 201 }) });
    const r = await s.run("start", "/srv/p", "--name", "x");
    expect(r.code).toBe(0);
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ path: "/srv/p", name: "x" });
    expect(s.out).toEqual([ID]);
    s.seen.length = 0;
    await s.run("start", "/srv/q");
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ path: "/srv/q" });
  });

  test("stop sends DELETE with the id", async () => {
    const s = setup({ [`DELETE /cli/api/hosts/local/instances/${ID}`]: () => new Response(null, { status: 204 }) });
    expect((await s.run("stop", ID)).code).toBe(0);
    expect(s.seen[0]!.method).toBe("DELETE");
  });

  test("logs sends lines and prints the raw log", async () => {
    const s = setup({ [`GET /cli/api/hosts/local/instances/${ID}/logs`]: () => ({ log: "line 1\nline 2" }) });
    await s.run("logs", ID, "--lines", "5");
    expect(s.seen[0]!.path).toBe(`/cli/api/hosts/local/instances/${ID}/logs?lines=5`);
    expect(s.out).toEqual(["line 1\nline 2"]);
    expect((await s.run("logs", ID, "--lines", "x")).code).toBe(1);
  });

  test("ls prints one path per line and sends the path query", async () => {
    const s = setup({ "GET /cli/api/hosts/local/fs": () => ({ path: "/srv", parent: null, dirs: [{ name: "a", path: "/srv/a" }, { name: "b", path: "/srv/b" }] }) });
    await s.run("ls", "/srv");
    expect(s.seen[0]!.path).toBe("/cli/api/hosts/local/fs?path=%2Fsrv");
    expect(s.out.join("\n")).toBe("/srv/a\n/srv/b");
  });

  test("mkdir sends parent and name and prints the new path", async () => {
    const s = setup({ "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }) });
    await s.run("mkdir", "/srv", "new");
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ parent: "/srv", name: "new" });
    expect(s.out).toEqual(["/srv/new"]);
  });

  test("whoami prints the name and username", async () => {
    const s = setup({ "GET /cli/api/me": () => ({ sub: "u1", name: "Ann", username: "kir" }) });
    await s.run("whoami");
    expect(s.out).toEqual(["Ann (kir)"]);
  });

  test("a host id with unusual characters is URL-encoded", async () => {
    const s = setup({});
    await s.run("list", "--host", "a/b");
    expect(s.seen[0]!.path).toBe("/cli/api/hosts/a%2Fb/instances");
  });

  test("a hub error prints its text on stderr and exits 1", async () => {
    const s = setup({ "POST /cli/api/hosts/local/instances": () => Response.json({ error: "already running" }, { status: 409 }) });
    const r = await s.run("start", "/srv/p");
    expect(r.code).toBe(1);
    expect(s.err).toEqual(["already running"]);
  });

  test("missing arguments print usage and exit 1", async () => {
    const s = setup({});
    for (const argv of [["start"], ["stop"], ["logs"], ["mkdir", "/srv"]]) expect((await s.run(...argv)).code).toBe(1);
    expect(s.seen).toHaveLength(0);
  });

  test("without a saved login the commands exit 2 with the login message", async () => {
    const s = setup({});
    s.env.credsFile = path.join(tmp(), "none.json");
    const r = await s.run("list");
    expect(r.code).toBe(2);
    expect(s.err[0]).toContain("claude-rc login");
  });

  test("an unknown command exits 1 even when not signed in", async () => {
    const s = setup({});
    s.env.credsFile = path.join(tmp(), "none.json");
    const r = await s.run("bogus");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain('unknown command "bogus"');
  });

  test("login without --hub or a saved hub is an error; logout deletes the file", async () => {
    const s = setup({});
    s.env.credsFile = path.join(tmp(), "none.json");
    const r = await s.run("login");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("--hub");
    const t = setup({});
    expect((await t.run("logout")).code).toBe(0);
    expect(existsSync(t.credsFile)).toBe(false);
  });
});
