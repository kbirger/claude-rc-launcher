import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../src/args";
import { runCommand } from "../src/commands";
import { ExitError, LOGIN_MESSAGE, saveCreds, type Credentials } from "../src/creds";
import type { HubClient } from "../src/hub";
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
  const env: Env = { credsFile, open: async () => {}, readLine: async () => "", sleep: async () => {} };
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

  test("ls --user sends the user query", async () => {
    const s = setup({ "GET /cli/api/hosts/local/fs": () => ({ path: "/srv", parent: null, dirs: [] }) });
    await s.run("ls", "/srv", "--user", "al ice");
    expect(s.seen[0]!.path).toBe("/cli/api/hosts/local/fs?path=%2Fsrv&user=al%20ice");
    s.seen.length = 0;
    await s.run("ls", "--user", "alice");
    expect(s.seen[0]!.path).toBe("/cli/api/hosts/local/fs?user=alice");
  });

  test("ls prints a lock after untrusted paths", async () => {
    const listing = { path: "/srv", parent: null, dirs: [{ name: "a", path: "/srv/a", trusted: true }, { name: "b", path: "/srv/b", trusted: false }] };
    const s = setup({ "GET /cli/api/hosts/local/fs": () => listing });
    await s.run("ls", "/srv");
    expect(s.out.join("\n")).toBe("/srv/a\n/srv/b \u{1F512}");
    s.out.length = 0;
    await s.run("ls", "/srv", "--json");
    expect(JSON.parse(s.out.join(""))).toEqual(listing);
  });

  test("start --user alice sends user and first calls GET /users", async () => {
    const s = setup({
      "GET /cli/api/hosts/local/users": () => ({ selectable: true, default: "alice", users: [{ name: "alice" }] }),
      "POST /cli/api/hosts/local/instances": () => new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/p", state: "active", startedAt: null }), { status: 201 }),
    });
    expect((await s.run("start", "/srv/p", "--user", "alice")).code).toBe(0);
    expect(s.seen.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /cli/api/hosts/local/users", "POST /cli/api/hosts/local/instances"]);
    expect(JSON.parse(s.seen[1]!.body)).toEqual({ path: "/srv/p", user: "alice" });
  });

  test("start --user fails clearly when /users is 404 and sends no POST", async () => {
    const s = setup({ "POST /cli/api/hosts/local/instances": () => ({}) });
    const r = await s.run("start", "/srv/p", "--user", "alice");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("this host does not support --user. Update the node.");
    expect(s.seen.filter((x) => x.method === "POST")).toHaveLength(0);
  });

  test("start without --force explains a 428", async () => {
    const s = setup({ "POST /cli/api/hosts/local/instances": () => Response.json({ error: "folder is not trusted", code: "untrusted", user: "alice", path: "/srv/p" }, { status: 428 }) });
    const r = await s.run("start", "/srv/p");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("folder is not trusted. Use --force to trust it");
  });

  test("an empty --user fails before any request", async () => {
    for (const argv of [["start", "/srv/p", "--user", ""], ["ls", "/srv", "--user", ""], ["ls", "--user="], ["mkdir", "/srv", "new", "--user", ""]]) {
      const s = setup();
      const r = await s.run(...argv);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("--user must not be empty");
      expect(s.seen).toHaveLength(0);
    }
  });

  test("start --force with a 428 says the host did not accept --force", async () => {
    const s = setup({ "POST /cli/api/hosts/local/instances": () => Response.json({ error: "folder is not trusted", code: "untrusted" }, { status: 428 }) });
    const r = await s.run("start", "/srv/p", "--force");
    expect(r.code).toBe(1);
    const msg = r.err.join("\n");
    expect(msg).toContain("folder is not trusted. The host did not accept --force. Update the hub and the node.");
    expect(msg).not.toContain("Use --force");
  });

  test("start --force sends addTrust true", async () => {
    const s = setup({ "POST /cli/api/hosts/local/instances": () => new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/p", state: "active", startedAt: null }), { status: 201 }) });
    expect((await s.run("start", "/srv/p", "--force")).code).toBe(0);
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ path: "/srv/p", addTrust: true });
  });

  test("mkdir sends parent and name and prints the new path", async () => {
    const s = setup({ "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }) });
    await s.run("mkdir", "/srv", "new");
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ parent: "/srv", name: "new" });
    expect(s.out).toEqual(["/srv/new"]);
  });

  test("mkdir --user sends the user and first calls GET /users", async () => {
    const s = setup({
      "GET /cli/api/hosts/local/users": () => [{ name: "alice", uid: 1000 }],
      "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }),
    });
    expect((await s.run("mkdir", "/srv", "new", "--user", "alice")).code).toBe(0);
    expect(s.seen.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /cli/api/hosts/local/users", "POST /cli/api/hosts/local/fs/mkdir"]);
    expect(JSON.parse(s.seen[1]!.body)).toEqual({ parent: "/srv", name: "new", user: "alice" });
    expect(s.out).toEqual(["/srv/new"]);
  });

  test("mkdir --user fails clearly when /users is 404 and creates nothing", async () => {
    const s = setup({ "GET /cli/api/hosts/local/users": () => Response.json({ error: "not found" }, { status: 404 }) });
    const r = await s.run("mkdir", "/srv", "new", "--user", "alice");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("this host does not support --user. Update the node.");
    expect(s.seen.filter((x) => x.method === "POST")).toHaveLength(0);
  });

  test("mkdir without --user makes no /users call", async () => {
    const s = setup({ "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }) });
    await s.run("mkdir", "/srv", "new");
    expect(s.seen).toHaveLength(1);
    expect(JSON.parse(s.seen[0]!.body)).not.toHaveProperty("user");
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

  test("update --all-nodes is parsed and goes to the hub with the saved login", async () => {
    const s = setup({
      "GET /cli/api/hosts": () => [{ id: "local", name: "hub", status: "ok", version: "1.0.0" }],
      "POST /cli/api/hosts/local/update": () => ({ status: "up-to-date", from: "1.0.0", clients: [] }),
    });
    // A source run: the client step fails, so the exit code is 1, but the hub was asked.
    s.env.sys = { execPath: "/usr/bin/bun", platform: "linux", arch: "x64" } as any;
    const r = await s.run("update", "--all-nodes", "--release", "v1.2.3");
    expect(r.code).toBe(1);
    expect(s.seen.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /cli/api/hosts", "POST /cli/api/hosts/local/update"]);
    expect(JSON.parse(s.seen[1]!.body)).toEqual({ release: "v1.2.3" });
    expect(s.out.join("\n")).toMatch(/^local .*up-to-date$/m);
    expect(s.err.at(-1)).toBe("1 of 2 machines were not updated");
  });

  test("update rejects a flag that belongs to --all-nodes only", async () => {
    const s = setup({});
    const r = await s.run("update", "--hub", "https://x");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("--hub does not apply to update");
    expect(s.seen).toEqual([]);
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

describe("clone, repos and gh-login", () => {
  const H = "/cli/api/hosts/local";
  const inst = () => new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/r", state: "active", startedAt: null }), { status: 201 });
  const accepted = () => new Response(JSON.stringify({ id: "job1", path: "/srv/r" }), { status: 202 });
  const seq = (...rs: (() => Response | unknown)[]) => { let i = 0; return () => rs[Math.min(i++, rs.length - 1)]!(); };
  const err = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

  test("clone posts repo and parent, polls until done, starts the instance and prints the id", async () => {
    const s = setup({
      [`POST ${H}/clone`]: accepted,
      [`GET ${H}/clone/job1`]: seq(() => ({ state: "running" }), () => ({ state: "done", path: "/srv/r" })),
      [`POST ${H}/instances`]: inst,
    });
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.code).toBe(0);
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ repo: "o/r", parent: "/srv" });
    expect(s.seen.filter((x) => x.path.endsWith("/clone/job1")).length).toBe(2);
    expect(JSON.parse(s.seen.at(-1)!.body)).toEqual({ path: "/srv/r" });
    expect(s.out).toEqual(["cloning o/r...", ID]);
  });

  test("clone --json prints only the instance and --force sends addTrust", async () => {
    const s = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }), [`POST ${H}/instances`]: inst });
    expect((await s.run("clone", "o/r", "/srv", "--json", "--force", "--name", "x")).code).toBe(0);
    expect(JSON.parse(s.seen.at(-1)!.body)).toEqual({ path: "/srv/r", name: "x", addTrust: true });
    expect(JSON.parse(s.out.join("\n")).id).toBe(ID);
  });

  test("a 428 on the start after a clone tells the user to use --force", async () => {
    const s = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }), [`POST ${H}/instances`]: err(428, { error: "untrusted", code: "untrusted" }) });
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/start \/srv\/r --force/);
  });

  test("clone POST 404 says the host cannot clone", async () => {
    const s = setup({});
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["this host cannot clone. Update the node."]);
  });

  test("clone POST 409 prints the message and starts nothing", async () => {
    const s = setup({ [`POST ${H}/clone`]: err(409, { error: "r already exists" }) });
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["r already exists"]);
    expect(s.seen.length).toBe(1);
  });

  test("a failed clone prints the error and does not start", async () => {
    const s = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "failed", error: "repository not found" }) });
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["repository not found"]);
    expect(s.seen.some((x) => x.path.endsWith("/instances"))).toBe(false);
  });

  test("one transient poll failure is retried", async () => {
    const s = setup({
      [`POST ${H}/clone`]: accepted,
      [`GET ${H}/clone/job1`]: seq(err(502, { error: "bad gateway" }), () => ({ state: "done", path: "/srv/r" })),
      [`POST ${H}/instances`]: inst,
    });
    expect((await s.run("clone", "o/r", "/srv")).code).toBe(0);
  });

  test("five poll failures in a row, or a poll 404, lose track of the clone", async () => {
    const lost = "lost track of the clone. Check the folder before trying again";
    const lostA = "lost track of the clone (x). Check the folder before trying again";
    const a = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: err(502, { error: "x" }) });
    expect((await a.run("clone", "o/r", "/srv")).err).toEqual([lostA]);
    expect(a.seen.filter((x) => x.path.endsWith("/clone/job1")).length).toBe(5);
    const b = setup({ [`POST ${H}/clone`]: accepted });
    expect((await b.run("clone", "o/r", "/srv")).err).toEqual([lost]);
    expect(b.seen.filter((x) => x.path.endsWith("/clone/job1")).length).toBe(1);
  });

  test("a clone that never finishes times out after 11 minutes", async () => {
    const s = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "running" }) });
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.err).toEqual(["clone timed out"]);
  });

  test("clone --user first checks /users and sends user", async () => {
    const s = setup({ [`GET ${H}/users`]: () => [], [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }), [`POST ${H}/instances`]: inst });
    expect((await s.run("clone", "o/r", "/srv", "--user", "alice")).code).toBe(0);
    expect(s.seen[0]!.path).toBe(`${H}/users`);
    expect(JSON.parse(s.seen[1]!.body)).toEqual({ repo: "o/r", parent: "/srv", user: "alice" });
  });

  test("clone needs two arguments", async () => {
    expect((await setup().run("clone", "o/r")).code).toBe(1);
  });

  const body = { groups: [{ owner: "o", repos: [{ name: "o/a", private: false, pushedAt: "t" }, { name: "o/b", private: true, pushedAt: "t" }] }, { owner: "p", repos: [{ name: "p/c", private: false, pushedAt: "t" }] }] };
  test("repos prints grouped lines and --json prints the body", async () => {
    const s = setup({ [`GET ${H}/github/repos`]: () => body });
    expect((await s.run("repos")).code).toBe(0);
    expect(s.out).toEqual(["o\n  o/a\n  o/b (private)\np\n  p/c"]);
    s.out.length = 0;
    await s.run("repos", "--json");
    expect(JSON.parse(s.out.join("\n"))).toEqual(body);
  });

  test("repos on a 409 github-login-required gives the hint, and a 404 says to update", async () => {
    const a = setup({ [`GET ${H}/github/repos`]: err(409, { error: "x", code: "github-login-required" }) });
    const r = await a.run("repos");
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['GitHub login required. Run "claude-rc gh-login"']);
    expect((await setup().run("repos")).err).toEqual(["this host cannot clone. Update the node."]);
  });

  test("gh-login prints the code and url, sends {} and exits 0 after done", async () => {
    const s = setup({ [`POST ${H}/github/login`]: () => new Response(JSON.stringify({ id: "l1", code: "ABCD-1234", url: "https://github.com/login/device" }), { status: 202 }), [`GET ${H}/github/login/l1`]: seq(() => ({ state: "pending" }), () => ({ state: "done" })) });
    const r = await s.run("gh-login");
    expect(r.code).toBe(0);
    expect(s.seen[0]!.body).toBe("{}");
    expect(r.out.join("\n")).toContain("ABCD-1234");
    expect(r.out.join("\n")).toContain("https://github.com/login/device");
    expect(r.out.at(-1)).toBe("signed in");
  });

  test("gh-login sends user, and exits 1 with the error on failed", async () => {
    const s = setup({ [`GET ${H}/users`]: () => [], [`POST ${H}/github/login`]: () => new Response(JSON.stringify({ id: "l1", code: "C", url: "u" }), { status: 202 }), [`GET ${H}/github/login/l1`]: () => ({ state: "failed", error: "access denied" }) });
    const r = await s.run("gh-login", "--user", "alice");
    expect(r.code).toBe(1);
    expect(JSON.parse(s.seen[1]!.body)).toEqual({ user: "alice" });
    expect(r.err).toEqual(["access denied"]);
  });

  test("the help text lists the three commands", async () => {
    const r = await setup().run("--help");
    for (const c of ["clone <repo> <parent>", "repos [--user", "gh-login [--user"]) expect(r.out.join("\n")).toContain(c);
  });

  const cloneDone = { [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }) };

  test("the 428 hint after a clone keeps the (admin) entry, quoted", async () => {
    const s = setup({ [`GET ${H}/users`]: () => [], ...cloneDone, [`POST ${H}/instances`]: err(428, { error: "/srv/r is not trusted" }) });
    const r = await s.run("clone", "o/r", "/srv", "--user", "svc (admin)");
    expect(r.err[0]).toContain(`start /srv/r --force --user 'svc (admin)'"`);
  });

  test("a 428 after a successful clone says where the clone is and how to start it", async () => {
    const s = setup({ ...cloneDone, [`POST ${H}/instances`]: err(428, { error: "/srv/r is not trusted" }) });
    const r = await s.run("clone", "o/r", "/srv");
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['/srv/r is not trusted. The repository was cloned to /srv/r. Run "claude-rc start /srv/r --force" to trust it and start']);
    const t = setup({ [`GET /cli/api/hosts/nas/users`]: () => [], [`POST /cli/api/hosts/nas/clone`]: accepted, [`GET /cli/api/hosts/nas/clone/job1`]: () => ({ state: "done", path: "/srv/r" }), [`POST /cli/api/hosts/nas/instances`]: err(428, { error: "/srv/r is not trusted" }) });
    const r2 = await t.run("clone", "o/r", "/srv", "--host", "nas", "--user", "alice");
    expect(r2.err[0]).toContain('"claude-rc start /srv/r --force --host nas --user alice"');
  });

  test("the start hint after a clone quotes a path with spaces or quotes and keeps --name", async () => {
    const done = (p: string) => ({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: () => ({ state: "done", path: p }), [`POST ${H}/instances`]: err(428, { error: "not trusted" }) });
    const a = await setup(done("/srv/my repo")).run("clone", "o/r", "/srv", "--name", "my name");
    expect(a.err[0]).toContain(`"claude-rc start '/srv/my repo' --force --name 'my name'"`);
    const b = await setup(done("/srv/it's")).run("clone", "o/r", "/srv", "--name", "x");
    expect(b.err[0]).toContain(`"claude-rc start '/srv/it'\\''s' --force --name x"`);
    const c = await setup(done("/srv/plain_1.2-x")).run("clone", "o/r", "/srv");
    expect(c.err[0]).toContain(`"claude-rc start /srv/plain_1.2-x --force"`);
  });

  test("an expired login (code 2) mid-poll surfaces at once", async () => {
    let polls = 0;
    const hub = {
      request: async (method: string, p: string) => {
        if (method === "POST") return { id: "job1", path: "/srv/r" };
        polls++;
        throw new ExitError(LOGIN_MESSAGE, 2);
      },
    } as unknown as HubClient;
    const e = await runCommand("clone", ["o/r", "/srv"], {} as Flags, hub, () => {}, async () => {}).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(ExitError);
    expect([(e as ExitError).code, (e as ExitError).message]).toEqual([2, LOGIN_MESSAGE]);
    expect(polls).toBe(1);
  });

  test("a 409 or a 500 after a successful clone still names the clone path", async () => {
    for (const status of [409, 500]) {
      const s = setup({ ...cloneDone, [`POST ${H}/instances`]: err(status, { error: "boom" }) });
      const r = await s.run("clone", "o/r", "/srv");
      expect(r.code).toBe(1);
      expect(r.err).toEqual(["boom. The repository was cloned to /srv/r"]);
    }
  });

  test("a 403 mid-poll surfaces at once, and the give-up text has the last error", async () => {
    const a = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: err(403, { error: "forbidden" }) });
    const r = await a.run("clone", "o/r", "/srv");
    expect(r.err).toEqual(["forbidden"]);
    expect(a.seen.filter((x) => x.path.endsWith("/clone/job1")).length).toBe(1);
    const b = setup({ [`POST ${H}/clone`]: accepted, [`GET ${H}/clone/job1`]: err(502, { error: "bad gateway" }) });
    expect((await b.run("clone", "o/r", "/srv")).err).toEqual(["lost track of the clone (bad gateway). Check the folder before trying again"]);
  });

  test("a login poll failing five times includes the last error and a 403 surfaces", async () => {
    const login = () => new Response(JSON.stringify({ id: "l1", code: "C", url: "u" }), { status: 202 });
    const a = setup({ [`POST ${H}/github/login`]: login, [`GET ${H}/github/login/l1`]: err(502, { error: "bad gateway" }) });
    expect((await a.run("gh-login")).err).toEqual(['lost track of the GitHub login (bad gateway). Run "claude-rc gh-login" again']);
    const b = setup({ [`POST ${H}/github/login`]: login, [`GET ${H}/github/login/l1`]: err(403, { error: "forbidden" }) });
    expect((await b.run("gh-login")).err).toEqual(["forbidden"]);
  });

  test("gh-login POST 404, poll 404 and timeout have their own messages", async () => {
    expect((await setup().run("gh-login")).err).toEqual(["this host cannot clone. Update the node."]);
    const login = () => new Response(JSON.stringify({ id: "l1", code: "C", url: "u" }), { status: 202 });
    const a = setup({ [`POST ${H}/github/login`]: login });
    expect((await a.run("gh-login")).err[0]).toMatch(/^lost track of the GitHub login\./);
    const b = setup({ [`POST ${H}/github/login`]: login, [`GET ${H}/github/login/l1`]: () => ({ state: "pending" }) });
    expect((await b.run("gh-login")).err).toEqual(["GitHub login timed out"]);
  });

  test("ids are URL-encoded in the poll paths", async () => {
    const enc = encodeURIComponent("a/b c");
    const a = setup({ [`POST ${H}/clone`]: () => new Response(JSON.stringify({ id: "a/b c", path: "/srv/r" }), { status: 202 }), [`GET ${H}/clone/${enc}`]: () => ({ state: "failed", error: "x" }) });
    expect((await a.run("clone", "o/r", "/srv")).err).toEqual(["x"]);
    const b = setup({ [`POST ${H}/github/login`]: () => new Response(JSON.stringify({ id: "a/b c", code: "C", url: "u" }), { status: 202 }), [`GET ${H}/github/login/${enc}`]: () => ({ state: "done" }) });
    expect((await b.run("gh-login")).code).toBe(0);
  });

  test("repos --user checks /users and passes user in the query; no groups prints no blank line", async () => {
    const s = setup({ [`GET ${H}/users`]: () => [], [`GET ${H}/github/repos`]: () => ({ groups: [] }) });
    expect((await s.run("repos", "--user", "a b")).code).toBe(0);
    expect(s.seen.map((x) => x.path)).toEqual([`${H}/users`, `${H}/github/repos?user=a%20b`]);
    expect(s.out).toEqual(["no repos"]);
  });
});
