import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../src/args";
import { runCommand } from "../src/commands";
import { ExitError, LOGIN_MESSAGE, saveCreds } from "../src/creds";
import type { Credentials } from "../src/creds";
import type { HubClient } from "../src/hub";
import { main } from "../src/index";
import type { Env } from "../src/index";
import { defined } from "./support";

const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-cmd-"));
const ID = "0123456789ab";

interface Seen {
  method: string;
  path: string;
  body: string;
}

function setup(routes: Record<string, () => Response | unknown> = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const parsedUrl = new URL(req.url);
      const key = `${req.method} ${parsedUrl.pathname}`;
      seen.push({ method: req.method, path: parsedUrl.pathname + parsedUrl.search, body: await req.text() });
      const route = routes[key];
      if (!route) return Response.json({ error: `no route ${key}` }, { status: 404 });
      const item = route();
      return item instanceof Response ? item : Response.json(item);
    },
  });
  stops.push(() => server.stop(true));
  const credsFile = path.join(tmp(), "credentials.json");
  const creds: Credentials = {
    hub: `http://127.0.0.1:${server.port}`,
    issuer: "i",
    clientId: "c",
    tokenEndpoint: "t",
    idToken: "tok",
    refreshToken: "r",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  saveCreds(credsFile, creds);
  const env: Env = { credsFile, open: async () => {}, readLine: () => Promise.resolve(""), sleep: async () => {} };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({
    code: await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env),
    out,
    err,
  });
  return { seen, run, out, err, env, credsFile };
}

describe("commands", () => {
  test("hosts prints a table and --json prints the response", async () => {
    const hosts = [
      { id: "local", name: "box", status: "ok" },
      { id: "nas", name: "NAS", status: "offline", error: "timeout", source: "config" },
    ];
    const harness = setup({ "GET /cli/api/hosts": () => hosts });
    expect((await harness.run("hosts")).code).toBe(0);
    expect(harness.out.join("\n")).toMatch(/ID\s+NAME\s+STATUS/);
    expect(harness.out.join("\n")).toMatch(/nas\s+NAS\s+offline: timeout/);
    harness.out.length = 0;
    await harness.run("hosts", "--json");
    expect(JSON.parse(harness.out.join("\n"))).toEqual(hosts);
  });

  test("list uses the host from --host and defaults to local", async () => {
    const inst = [{ id: ID, name: "n", state: "active", path: "/srv/p", startedAt: null }];
    const harness = setup({
      "GET /cli/api/hosts/local/instances": () => inst,
      "GET /cli/api/hosts/nas/instances": () => inst,
    });
    await harness.run("list");
    await harness.run("list", "--host", "nas");
    expect(harness.seen.map((seen) => seen.path)).toEqual([
      "/cli/api/hosts/local/instances",
      "/cli/api/hosts/nas/instances",
    ]);
    expect(harness.out.join("\n")).toMatch(new RegExp(`${ID}\\s+n\\s+active\\s+-\\s+/srv/p`));
    expect(harness.out.join("\n")).toMatch(/STATE\s+SETTINGS\s+PATH/);
    expect(harness.out.join("\n")).toMatch(new RegExp(`${ID}\\s+n\\s+active\\s+-\\s+/srv/p`));
  });

  test("list adds a USER column only when an instance has a user", async () => {
    const withUser = [{ id: ID, name: "n", state: "active", path: "/srv/p", startedAt: null, user: "svc (admin)" }];
    const harness = setup({ "GET /cli/api/hosts/local/instances": () => withUser });
    await harness.run("list");
    expect(harness.out.join("\n")).toMatch(new RegExp(`ID\\s+NAME\\s+STATE\\s+USER\\s+SETTINGS\\s+PATH`));
    expect(harness.out.join("\n")).toMatch(new RegExp(`${ID}\\s+n\\s+active\\s+svc \\(admin\\)\\s+-\\s+/srv/p`));
    const plain = setup({ "GET /cli/api/hosts/local/instances": () => [{ ...withUser[0], user: undefined }] });
    await plain.run("list");
    expect(plain.out.join("\n")).not.toContain("USER");
  });

  test("start sends path and name and prints the new id", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/instances": () =>
        new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/p", state: "active", startedAt: null }), {
          status: 201,
        }),
    });
    const outcome = await harness.run("start", "/srv/p", "--name", "x");
    expect(outcome.code).toBe(0);
    expect(JSON.parse(harness.seen[0].body)).toEqual({ path: "/srv/p", name: "x" });
    expect(harness.out).toEqual([ID]);
    harness.seen.length = 0;
    await harness.run("start", "/srv/q");
    expect(JSON.parse(harness.seen[0].body)).toEqual({ path: "/srv/q" });
  });

  test("stop sends DELETE with the id", async () => {
    const harness = setup({
      [`DELETE /cli/api/hosts/local/instances/${ID}`]: () => new Response(null, { status: 204 }),
    });
    expect((await harness.run("stop", ID)).code).toBe(0);
    expect(harness.seen[0].method).toBe("DELETE");
  });

  test("logs sends lines and prints the raw log", async () => {
    const harness = setup({ [`GET /cli/api/hosts/local/instances/${ID}/logs`]: () => ({ log: "line 1\nline 2" }) });
    await harness.run("logs", ID, "--lines", "5");
    expect(harness.seen[0].path).toBe(`/cli/api/hosts/local/instances/${ID}/logs?lines=5`);
    expect(harness.out).toEqual(["line 1\nline 2"]);
    expect((await harness.run("logs", ID, "--lines", "x")).code).toBe(1);
  });

  test("ls prints one path per line and sends the path query", async () => {
    const harness = setup({
      "GET /cli/api/hosts/local/fs": () => ({
        path: "/srv",
        parent: null,
        dirs: [
          { name: "a", path: "/srv/a" },
          { name: "b", path: "/srv/b" },
        ],
      }),
    });
    await harness.run("ls", "/srv");
    expect(harness.seen[0].path).toBe("/cli/api/hosts/local/fs?path=%2Fsrv");
    expect(harness.out.join("\n")).toBe("/srv/a\n/srv/b");
  });

  test("ls --user sends the user query", async () => {
    const harness = setup({ "GET /cli/api/hosts/local/fs": () => ({ path: "/srv", parent: null, dirs: [] }) });
    await harness.run("ls", "/srv", "--user", "al ice");
    expect(harness.seen[0].path).toBe("/cli/api/hosts/local/fs?path=%2Fsrv&user=al%20ice");
    harness.seen.length = 0;
    await harness.run("ls", "--user", "alice");
    expect(harness.seen[0].path).toBe("/cli/api/hosts/local/fs?user=alice");
  });

  test("ls prints a lock after untrusted paths", async () => {
    const listing = {
      path: "/srv",
      parent: null,
      dirs: [
        { name: "a", path: "/srv/a", trusted: true },
        { name: "b", path: "/srv/b", trusted: false },
      ],
    };
    const harness = setup({ "GET /cli/api/hosts/local/fs": () => listing });
    await harness.run("ls", "/srv");
    expect(harness.out.join("\n")).toBe("/srv/a\n/srv/b \u{1F512}");
    harness.out.length = 0;
    await harness.run("ls", "/srv", "--json");
    expect(JSON.parse(harness.out.join(""))).toEqual(listing);
  });

  test("start --user alice sends user and first calls GET /users", async () => {
    const harness = setup({
      "GET /cli/api/hosts/local/users": () => ({ selectable: true, default: "alice", users: [{ name: "alice" }] }),
      "POST /cli/api/hosts/local/instances": () =>
        new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/p", state: "active", startedAt: null }), {
          status: 201,
        }),
    });
    expect((await harness.run("start", "/srv/p", "--user", "alice")).code).toBe(0);
    expect(harness.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      "GET /cli/api/hosts/local/users",
      "POST /cli/api/hosts/local/instances",
    ]);
    expect(JSON.parse(harness.seen[1].body)).toEqual({ path: "/srv/p", user: "alice" });
  });

  test("start --user fails clearly when /users is 404 and sends no POST", async () => {
    const harness = setup({ "POST /cli/api/hosts/local/instances": () => ({}) });
    const outcome = await harness.run("start", "/srv/p", "--user", "alice");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("this host does not support --user. Update the node.");
    expect(harness.seen.filter((seen) => seen.method === "POST")).toHaveLength(0);
  });

  test("start without --force explains a 428", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/instances": () =>
        Response.json(
          { error: "folder is not trusted", code: "untrusted", user: "alice", path: "/srv/p" },
          { status: 428 },
        ),
    });
    const outcome = await harness.run("start", "/srv/p");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("folder is not trusted. Use --force to trust it");
  });

  test("an empty --user fails before any request", async () => {
    for (const argv of [
      ["start", "/srv/p", "--user", ""],
      ["ls", "/srv", "--user", ""],
      ["ls", "--user="],
      ["mkdir", "/srv", "new", "--user", ""],
    ]) {
      const harness = setup();
      const outcome = await harness.run(...argv);
      expect(outcome.code).toBe(1);
      expect(outcome.err.join("\n")).toContain("--user must not be empty");
      expect(harness.seen).toHaveLength(0);
    }
  });

  test("start --force with a 428 says the host did not accept --force", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/instances": () =>
        Response.json({ error: "folder is not trusted", code: "untrusted" }, { status: 428 }),
    });
    const outcome = await harness.run("start", "/srv/p", "--force");
    expect(outcome.code).toBe(1);
    const msg = outcome.err.join("\n");
    expect(msg).toContain("folder is not trusted. The host did not accept --force. Update the hub and the node.");
    expect(msg).not.toContain("Use --force");
  });

  test("start --force sends addTrust true", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/instances": () =>
        new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/p", state: "active", startedAt: null }), {
          status: 201,
        }),
    });
    expect((await harness.run("start", "/srv/p", "--force")).code).toBe(0);
    expect(JSON.parse(harness.seen[0].body)).toEqual({ path: "/srv/p", addTrust: true });
  });

  test("mkdir sends parent and name and prints the new path", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }),
    });
    await harness.run("mkdir", "/srv", "new");
    expect(JSON.parse(harness.seen[0].body)).toEqual({ parent: "/srv", name: "new" });
    expect(harness.out).toEqual(["/srv/new"]);
  });

  test("mkdir --user sends the user and first calls GET /users", async () => {
    const harness = setup({
      "GET /cli/api/hosts/local/users": () => [{ name: "alice", uid: 1000 }],
      "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }),
    });
    expect((await harness.run("mkdir", "/srv", "new", "--user", "alice")).code).toBe(0);
    expect(harness.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      "GET /cli/api/hosts/local/users",
      "POST /cli/api/hosts/local/fs/mkdir",
    ]);
    expect(JSON.parse(harness.seen[1].body)).toEqual({ parent: "/srv", name: "new", user: "alice" });
    expect(harness.out).toEqual(["/srv/new"]);
  });

  test("mkdir --user fails clearly when /users is 404 and creates nothing", async () => {
    const harness = setup({
      "GET /cli/api/hosts/local/users": () => Response.json({ error: "not found" }, { status: 404 }),
    });
    const outcome = await harness.run("mkdir", "/srv", "new", "--user", "alice");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("this host does not support --user. Update the node.");
    expect(harness.seen.filter((seen) => seen.method === "POST")).toHaveLength(0);
  });

  test("mkdir without --user makes no /users call", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/fs/mkdir": () => new Response(JSON.stringify({ path: "/srv/new" }), { status: 201 }),
    });
    await harness.run("mkdir", "/srv", "new");
    expect(harness.seen).toHaveLength(1);
    expect(JSON.parse(harness.seen[0].body)).not.toHaveProperty("user");
  });

  test("whoami prints the name and username", async () => {
    const harness = setup({ "GET /cli/api/me": () => ({ sub: "u1", name: "Ann", username: "kir" }) });
    await harness.run("whoami");
    expect(harness.out).toEqual(["Ann (kir)"]);
  });

  test("a host id with unusual characters is URL-encoded", async () => {
    const harness = setup({});
    await harness.run("list", "--host", "a/b");
    expect(harness.seen[0].path).toBe("/cli/api/hosts/a%2Fb/instances");
  });

  test("a hub error prints its text on stderr and exits 1", async () => {
    const harness = setup({
      "POST /cli/api/hosts/local/instances": () => Response.json({ error: "already running" }, { status: 409 }),
    });
    const outcome = await harness.run("start", "/srv/p");
    expect(outcome.code).toBe(1);
    expect(harness.err).toEqual(["already running"]);
  });

  test("missing arguments print usage and exit 1", async () => {
    const harness = setup({});
    for (const argv of [["start"], ["stop"], ["logs"], ["mkdir", "/srv"]])
      expect((await harness.run(...argv)).code).toBe(1);
    expect(harness.seen).toHaveLength(0);
  });

  test("without a saved login the commands exit 2 with the login message", async () => {
    const harness = setup({});
    harness.env.credsFile = path.join(tmp(), "none.json");
    const outcome = await harness.run("list");
    expect(outcome.code).toBe(2);
    expect(harness.err[0]).toContain("claude-rc login");
  });

  test("update --all-nodes is parsed and goes to the hub with the saved login", async () => {
    const harness = setup({
      "GET /cli/api/hosts": () => [{ id: "local", name: "hub", status: "ok", version: "1.0.0" }],
      "POST /cli/api/hosts/local/update": () => ({ status: "up-to-date", from: "1.0.0", clients: [] }),
    });
    // A source run: the client step fails, so the exit code is 1, but the hub was asked.
    harness.env.sys = {
      execPath: "/usr/bin/bun",
      platform: "linux",
      arch: "x64",
      sleep: async () => {},
      now: () => 0,
    } as any;
    const outcome = await harness.run("update", "--all-nodes", "--release", "v1.2.3");
    expect(outcome.code).toBe(1);
    expect(harness.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      "GET /cli/api/hosts",
      "GET /cli/api/events",
      "POST /cli/api/hosts/local/update",
    ]);
    expect(JSON.parse(harness.seen[2].body)).toEqual({ release: "v1.2.3" });
    expect(harness.out.join("\n")).toMatch(/^local .*up-to-date$/m);
    expect(harness.err.at(-1)).toBe("1 of 2 machines were not updated");
  });

  test("update rejects a flag that belongs to --all-nodes only", async () => {
    const harness = setup({});
    const outcome = await harness.run("update", "--hub", "https://x");
    expect(outcome.code).toBe(1);
    expect(harness.err[0]).toContain("--hub does not apply to update");
    expect(harness.seen).toEqual([]);
  });

  test("an unknown command exits 1 even when not signed in", async () => {
    const harness = setup({});
    harness.env.credsFile = path.join(tmp(), "none.json");
    const outcome = await harness.run("bogus");
    expect(outcome.code).toBe(1);
    expect(harness.err[0]).toContain('unknown command "bogus"');
  });

  test("login without --hub or a saved hub is an error; logout deletes the file", async () => {
    const harness = setup({});
    harness.env.credsFile = path.join(tmp(), "none.json");
    const outcome = await harness.run("login");
    expect(outcome.code).toBe(1);
    expect(harness.err[0]).toContain("--hub");
    const fixture = setup({});
    expect((await fixture.run("logout")).code).toBe(0);
    expect(existsSync(fixture.credsFile)).toBe(false);
  });
});

describe("clone, repos and gh-login", () => {
  const item = "/cli/api/hosts/local";
  const inst = () =>
    new Response(JSON.stringify({ id: ID, name: "x", path: "/srv/r", state: "active", startedAt: null }), {
      status: 201,
    });
  const accepted = () => new Response(JSON.stringify({ id: "job1", path: "/srv/r" }), { status: 202 });

  const seq = (...rs: (() => Response | unknown)[]) => {
    let count = 0;
    return () => rs[Math.min(count++, rs.length - 1)]();
  };

  const err = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

  test("clone posts repo and parent, polls until done, starts the instance and prints the id", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: seq(
        () => ({ state: "running" }),
        () => ({ state: "done", path: "/srv/r" }),
      ),
      [`POST ${item}/instances`]: inst,
    });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.code).toBe(0);
    expect(JSON.parse(harness.seen[0].body)).toEqual({ repo: "o/r", parent: "/srv" });
    expect(harness.seen.filter((seen) => seen.path.endsWith("/clone/job1")).length).toBe(2);
    expect(JSON.parse(defined(harness.seen.at(-1)).body)).toEqual({ path: "/srv/r" });
    expect(harness.out).toEqual(["cloning o/r...", ID]);
  });

  test("clone --json prints only the instance and --force sends addTrust", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }),
      [`POST ${item}/instances`]: inst,
    });
    expect((await harness.run("clone", "o/r", "/srv", "--json", "--force", "--name", "x")).code).toBe(0);
    expect(JSON.parse(defined(harness.seen.at(-1)).body)).toEqual({ path: "/srv/r", name: "x", addTrust: true });
    expect(JSON.parse(harness.out.join("\n")).id).toBe(ID);
  });

  test("a 428 on the start after a clone tells the user to use --force", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }),
      [`POST ${item}/instances`]: err(428, { error: "untrusted", code: "untrusted" }),
    });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toMatch(/start \/srv\/r --force/);
  });

  test("clone POST 404 says the host cannot clone", async () => {
    const harness = setup({});
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual(["this host cannot clone. Update the node."]);
  });

  test("clone POST 409 prints the message and starts nothing", async () => {
    const harness = setup({ [`POST ${item}/clone`]: err(409, { error: "r already exists" }) });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual(["r already exists"]);
    expect(harness.seen.length).toBe(1);
  });

  test("a failed clone prints the error and does not start", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: () => ({ state: "failed", error: "repository not found" }),
    });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual(["repository not found"]);
    expect(harness.seen.some((seen) => seen.path.endsWith("/instances"))).toBe(false);
  });

  test("one transient poll failure is retried", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: seq(err(502, { error: "bad gateway" }), () => ({ state: "done", path: "/srv/r" })),
      [`POST ${item}/instances`]: inst,
    });
    expect((await harness.run("clone", "o/r", "/srv")).code).toBe(0);
  });

  test("five poll failures in a row, or a poll 404, lose track of the clone", async () => {
    const lost = "lost track of the clone. Check the folder before trying again";
    const lostA = "lost track of the clone (x). Check the folder before trying again";
    const harness = setup({ [`POST ${item}/clone`]: accepted, [`GET ${item}/clone/job1`]: err(502, { error: "x" }) });
    expect((await harness.run("clone", "o/r", "/srv")).err).toEqual([lostA]);
    expect(harness.seen.filter((seen) => seen.path.endsWith("/clone/job1")).length).toBe(5);
    const fixture = setup({ [`POST ${item}/clone`]: accepted });
    expect((await fixture.run("clone", "o/r", "/srv")).err).toEqual([lost]);
    expect(fixture.seen.filter((seen) => seen.path.endsWith("/clone/job1")).length).toBe(1);
  });

  test("a clone that never finishes times out after 11 minutes", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: () => ({ state: "running" }),
    });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.err).toEqual(["clone timed out"]);
  });

  test("clone --user first checks /users and sends user", async () => {
    const harness = setup({
      [`GET ${item}/users`]: () => [],
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }),
      [`POST ${item}/instances`]: inst,
    });
    expect((await harness.run("clone", "o/r", "/srv", "--user", "alice")).code).toBe(0);
    expect(harness.seen[0].path).toBe(`${item}/users`);
    expect(JSON.parse(harness.seen[1].body)).toEqual({ repo: "o/r", parent: "/srv", user: "alice" });
  });

  test("clone needs two arguments", async () => {
    expect((await setup().run("clone", "o/r")).code).toBe(1);
  });

  const body = {
    groups: [
      {
        owner: "o",
        repos: [
          { name: "o/a", private: false, pushedAt: "t" },
          { name: "o/b", private: true, pushedAt: "t" },
        ],
      },
      { owner: "p", repos: [{ name: "p/c", private: false, pushedAt: "t" }] },
    ],
  };
  test("repos prints grouped lines and --json prints the body", async () => {
    const harness = setup({ [`GET ${item}/github/repos`]: () => body });
    expect((await harness.run("repos")).code).toBe(0);
    expect(harness.out).toEqual(["o\n  o/a\n  o/b (private)\np\n  p/c"]);
    harness.out.length = 0;
    await harness.run("repos", "--json");
    expect(JSON.parse(harness.out.join("\n"))).toEqual(body);
  });

  test("repos on a 409 github-login-required gives the hint, and a 404 says to update", async () => {
    const harness = setup({ [`GET ${item}/github/repos`]: err(409, { error: "x", code: "github-login-required" }) });
    const outcome = await harness.run("repos");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual(['GitHub login required. Run "claude-rc gh-login"']);
    expect((await setup().run("repos")).err).toEqual(["this host cannot clone. Update the node."]);
  });

  test("gh-login prints the code and url, sends {} and exits 0 after done", async () => {
    const harness = setup({
      [`POST ${item}/github/login`]: () =>
        new Response(JSON.stringify({ id: "l1", code: "ABCD-1234", url: "https://github.com/login/device" }), {
          status: 202,
        }),
      [`GET ${item}/github/login/l1`]: seq(
        () => ({ state: "pending" }),
        () => ({ state: "done" }),
      ),
    });
    const outcome = await harness.run("gh-login");
    expect(outcome.code).toBe(0);
    expect(harness.seen[0].body).toBe("{}");
    expect(outcome.out.join("\n")).toContain("ABCD-1234");
    expect(outcome.out.join("\n")).toContain("https://github.com/login/device");
    expect(outcome.out.at(-1)).toBe("signed in");
  });

  test("gh-login sends user, and exits 1 with the error on failed", async () => {
    const harness = setup({
      [`GET ${item}/users`]: () => [],
      [`POST ${item}/github/login`]: () =>
        new Response(JSON.stringify({ id: "l1", code: "C", url: "u" }), { status: 202 }),
      [`GET ${item}/github/login/l1`]: () => ({ state: "failed", error: "access denied" }),
    });
    const outcome = await harness.run("gh-login", "--user", "alice");
    expect(outcome.code).toBe(1);
    expect(JSON.parse(harness.seen[1].body)).toEqual({ user: "alice" });
    expect(outcome.err).toEqual(["access denied"]);
  });

  test("the help text lists the three commands", async () => {
    const outcome = await setup().run("--help");
    for (const entry of ["clone <repo> <parent>", "repos [--user", "gh-login [--user"])
      expect(outcome.out.join("\n")).toContain(entry);
  });

  const cloneDone = {
    [`POST ${item}/clone`]: accepted,
    [`GET ${item}/clone/job1`]: () => ({ state: "done", path: "/srv/r" }),
  };

  test("the 428 hint after a clone keeps the (admin) entry, quoted", async () => {
    const harness = setup({
      [`GET ${item}/users`]: () => [],
      ...cloneDone,
      [`POST ${item}/instances`]: err(428, { error: "/srv/r is not trusted" }),
    });
    const outcome = await harness.run("clone", "o/r", "/srv", "--user", "svc (admin)");
    expect(outcome.err[0]).toContain(`start /srv/r --force --user 'svc (admin)'"`);
  });

  test("a 428 after a successful clone says where the clone is and how to start it", async () => {
    const harness = setup({ ...cloneDone, [`POST ${item}/instances`]: err(428, { error: "/srv/r is not trusted" }) });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual([
      '/srv/r is not trusted. The repository was cloned to /srv/r. Run "claude-rc start /srv/r --force" to trust it and start',
    ]);
    const fixture = setup({
      [`GET /cli/api/hosts/nas/users`]: () => [],
      [`POST /cli/api/hosts/nas/clone`]: accepted,
      [`GET /cli/api/hosts/nas/clone/job1`]: () => ({ state: "done", path: "/srv/r" }),
      [`POST /cli/api/hosts/nas/instances`]: err(428, { error: "/srv/r is not trusted" }),
    });
    const r2 = await fixture.run("clone", "o/r", "/srv", "--host", "nas", "--user", "alice");
    expect(r2.err[0]).toContain('"claude-rc start /srv/r --force --host nas --user alice"');
  });

  test("the start hint after a clone quotes a path with spaces or quotes and keeps --name", async () => {
    const done = (element: string) => ({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: () => ({ state: "done", path: element }),
      [`POST ${item}/instances`]: err(428, { error: "not trusted" }),
    });
    const outcome = await setup(done("/srv/my repo")).run("clone", "o/r", "/srv", "--name", "my name");
    expect(outcome.err[0]).toContain(`"claude-rc start '/srv/my repo' --force --name 'my name'"`);
    const harness = await setup(done("/srv/it's")).run("clone", "o/r", "/srv", "--name", "x");
    expect(harness.err[0]).toContain(`"claude-rc start '/srv/it'\\''s' --force --name x"`);
    const fixture = await setup(done("/srv/plain_1.2-x")).run("clone", "o/r", "/srv");
    expect(fixture.err[0]).toContain(`"claude-rc start /srv/plain_1.2-x --force"`);
  });

  test("an expired login (code 2) mid-poll surfaces at once", async () => {
    let polls = 0;
    const hub = {
      request: (method: string, _value: string) => {
        if (method === "POST") return Promise.resolve({ id: "job1", path: "/srv/r" });
        polls++;
        return Promise.reject(new ExitError(LOGIN_MESSAGE, 2));
      },
    } as unknown as HubClient;
    const entry = await runCommand(
      "clone",
      ["o/r", "/srv"],
      {},
      hub,
      () => {},
      async () => {},
    ).then(
      () => undefined,
      (value) => value,
    );
    expect(entry).toBeInstanceOf(ExitError);
    expect([(entry as ExitError).code, (entry as ExitError).message]).toEqual([2, LOGIN_MESSAGE]);
    expect(polls).toBe(1);
  });

  test("a 409 or a 500 after a successful clone still names the clone path", async () => {
    for (const status of [409, 500]) {
      const harness = setup({ ...cloneDone, [`POST ${item}/instances`]: err(status, { error: "boom" }) });
      const outcome = await harness.run("clone", "o/r", "/srv");
      expect(outcome.code).toBe(1);
      expect(outcome.err).toEqual(["boom. The repository was cloned to /srv/r"]);
    }
  });

  test("a 403 mid-poll surfaces at once, and the give-up text has the last error", async () => {
    const harness = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: err(403, { error: "forbidden" }),
    });
    const outcome = await harness.run("clone", "o/r", "/srv");
    expect(outcome.err).toEqual(["forbidden"]);
    expect(harness.seen.filter((seen) => seen.path.endsWith("/clone/job1")).length).toBe(1);
    const fixture = setup({
      [`POST ${item}/clone`]: accepted,
      [`GET ${item}/clone/job1`]: err(502, { error: "bad gateway" }),
    });
    expect((await fixture.run("clone", "o/r", "/srv")).err).toEqual([
      "lost track of the clone (bad gateway). Check the folder before trying again",
    ]);
  });

  test("a login poll failing five times includes the last error and a 403 surfaces", async () => {
    const login = () => new Response(JSON.stringify({ id: "l1", code: "C", url: "u" }), { status: 202 });
    const harness = setup({
      [`POST ${item}/github/login`]: login,
      [`GET ${item}/github/login/l1`]: err(502, { error: "bad gateway" }),
    });
    expect((await harness.run("gh-login")).err).toEqual([
      'lost track of the GitHub login (bad gateway). Run "claude-rc gh-login" again',
    ]);
    const fixture = setup({
      [`POST ${item}/github/login`]: login,
      [`GET ${item}/github/login/l1`]: err(403, { error: "forbidden" }),
    });
    expect((await fixture.run("gh-login")).err).toEqual(["forbidden"]);
  });

  test("gh-login POST 404, poll 404 and timeout have their own messages", async () => {
    expect((await setup().run("gh-login")).err).toEqual(["this host cannot clone. Update the node."]);
    const login = () => new Response(JSON.stringify({ id: "l1", code: "C", url: "u" }), { status: 202 });
    const harness = setup({ [`POST ${item}/github/login`]: login });
    expect((await harness.run("gh-login")).err[0]).toMatch(/^lost track of the GitHub login\./);
    const fixture = setup({
      [`POST ${item}/github/login`]: login,
      [`GET ${item}/github/login/l1`]: () => ({ state: "pending" }),
    });
    expect((await fixture.run("gh-login")).err).toEqual(["GitHub login timed out"]);
  });

  test("ids are URL-encoded in the poll paths", async () => {
    const enc = encodeURIComponent("a/b c");
    const harness = setup({
      [`POST ${item}/clone`]: () => new Response(JSON.stringify({ id: "a/b c", path: "/srv/r" }), { status: 202 }),
      [`GET ${item}/clone/${enc}`]: () => ({ state: "failed", error: "x" }),
    });
    expect((await harness.run("clone", "o/r", "/srv")).err).toEqual(["x"]);
    const fixture = setup({
      [`POST ${item}/github/login`]: () =>
        new Response(JSON.stringify({ id: "a/b c", code: "C", url: "u" }), { status: 202 }),
      [`GET ${item}/github/login/${enc}`]: () => ({ state: "done" }),
    });
    expect((await fixture.run("gh-login")).code).toBe(0);
  });

  test("repos --user checks /users and passes user in the query; no groups prints no blank line", async () => {
    const harness = setup({ [`GET ${item}/users`]: () => [], [`GET ${item}/github/repos`]: () => ({ groups: [] }) });
    expect((await harness.run("repos", "--user", "a b")).code).toBe(0);
    expect(harness.seen.map((seen) => seen.path)).toEqual([`${item}/users`, `${item}/github/repos?user=a%20b`]);
    expect(harness.out).toEqual(["no repos"]);
  });

  describe("instance settings", () => {
    const base = "/cli/api/hosts/local/instances";
    const inst = (over = {}) => ({
      id: ID,
      name: "n",
      state: "active",
      path: "/srv/p",
      startedAt: null,
      settings: { createSession: true, spawnMode: "same-dir" },
      ...over,
    });
    const help = {
      settings: [
        {
          key: "createSession",
          label: "Create a session at start",
          values: [{ value: true, label: "On", explanation: "Makes one session.\u001b[31m" }],
          limits: "A change restarts the instance.",
        },
      ],
    };

    test("start sends only the given settings", async () => {
      const harness = setup({
        [`POST ${base}`]: () => new Response(JSON.stringify(inst()), { status: 201 }),
        "GET /cli/api/hosts/local/instance-settings": () => help,
      });
      await harness.run("start", "/srv/p", "--no-create-session", "--spawn", "worktree");
      const post = () => harness.seen.filter((seen) => seen.method === "POST");
      expect(harness.seen[0].path).toBe("/cli/api/hosts/local/instance-settings");
      expect(JSON.parse(post()[0].body)).toEqual({ path: "/srv/p", createSession: false, spawnMode: "worktree" });
      harness.seen.length = 0;
      await harness.run("start", "/srv/p", "--create-session");
      expect(JSON.parse(post()[0].body)).toEqual({ path: "/srv/p", createSession: true });
      harness.seen.length = 0;
      await harness.run("start", "/srv/p");
      // With no settings flag, no help request is made.
      expect(harness.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([`POST ${base}`]);
      expect(JSON.parse(harness.seen[0].body)).toEqual({ path: "/srv/p" });
    });

    test("start with a settings flag on an old node or hub (help 404) fails and starts nothing", async () => {
      const harness = setup({ [`POST ${base}`]: () => new Response(JSON.stringify(inst()), { status: 201 }) });

      for (const flag of [["--spawn", "worktree"], ["--create-session"], ["--no-create-session"]]) {
        harness.err.length = 0;
        const outcome = await harness.run("start", "/srv/p", ...flag);
        expect(outcome.code).toBe(1);
        expect(harness.err).toEqual(["This node cannot take instance settings. Update the node and the hub first."]);
      }

      expect(harness.seen.some((seen) => seen.method === "POST")).toBe(false);
    });

    test("clone with a settings flag checks the node before it clones", async () => {
      const harness = setup({
        "POST /cli/api/hosts/local/clone": () =>
          new Response(JSON.stringify({ id: "job1", path: "/srv/r" }), { status: 202 }),
      });
      const outcome = await harness.run("clone", "o/r", "/srv", "--spawn", "worktree");
      expect(outcome.code).toBe(1);
      expect(harness.err).toEqual(["This node cannot take instance settings. Update the node and the hub first."]);
      expect(harness.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
        "GET /cli/api/hosts/local/instance-settings",
      ]);
    });

    test("clone with a bad spawn value fails before it clones", async () => {
      const harness = setup({});
      const outcome = await harness.run("clone", "o/r", "/srv", "--spawn", "tree");
      expect(outcome.code).toBe(1);
      expect(harness.seen).toEqual([]);
    });

    test("clone with a settings flag on a new node sends the settings with the start", async () => {
      const harness = setup({
        "GET /cli/api/hosts/local/instance-settings": () => help,
        "POST /cli/api/hosts/local/clone": () =>
          new Response(JSON.stringify({ id: "job1", path: "/srv/r" }), { status: 202 }),
        "GET /cli/api/hosts/local/clone/job1": () => ({ state: "done", path: "/srv/r" }),
        [`POST ${base}`]: () => new Response(JSON.stringify(inst()), { status: 201 }),
      });
      const outcome = await harness.run("clone", "o/r", "/srv", "--no-create-session");
      expect(outcome.code).toBe(0);
      expect(JSON.parse(defined(harness.seen.find((seen) => seen.path === base)).body)).toEqual({
        path: "/srv/r",
        createSession: false,
      });
    });

    test("start refuses both session flags and a wrong spawn value", async () => {
      const harness = setup({});
      const outcome = await harness.run("start", "/srv/p", "--create-session", "--no-create-session");
      expect(outcome.code).toBe(1);
      expect(harness.err.join("\n")).toContain("not both");
      harness.err.length = 0;
      const fixture = await harness.run("start", "/srv/p", "--spawn", "tree");
      expect(fixture.code).toBe(1);
      expect(harness.err.join("\n")).toContain("same-dir or worktree");
      expect(harness.seen).toEqual([]);
    });

    test("list shows the settings column", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst({ settings: { createSession: false, spawnMode: "worktree" } })],
      });
      await harness.run("list");
      expect(harness.out.join("\n")).toMatch(/session:off spawn:worktree\s+\/srv\/p/);
    });

    test("settings prints the values and the explanations without control characters", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        "GET /cli/api/hosts/local/instance-settings": () => help,
      });
      expect((await harness.run("settings", ID)).code).toBe(0);
      const text = harness.out.join("\n");
      expect(text).toContain("create-session: on");
      expect(text).toContain("spawn: same-dir");
      expect(text).toContain("On: Makes one session.?[31m");
      expect(text).not.toContain("\u001b");
    });

    test("settings says so when the node has no explanations, and --json prints only the settings", async () => {
      const harness = setup({ [`GET ${base}`]: () => [inst()] });
      await harness.run("settings", ID);
      expect(harness.out.join("\n")).toContain("does not offer explanations");
      harness.out.length = 0;
      await harness.run("settings", ID, "--json");
      expect(JSON.parse(harness.out.join("\n"))).toEqual({ createSession: true, spawnMode: "same-dir" });
    });

    test("a change asks first and sends nothing on no", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () => ({ instance: inst(), previous: inst().settings }),
      });
      const prompts: string[] = [];
      harness.env.readLine = (prompt) => Promise.resolve((prompts.push(prompt), "n"));
      const outcome = await harness.run("settings", ID, "--no-create-session");
      expect(outcome.code).toBe(1);
      expect(harness.err).toEqual(["not changed"]);
      expect(harness.out.join("\n")).toContain("create-session: on to off");
      expect(harness.out.join("\n")).toContain("restarts the server");
      expect(prompts.length).toBe(1);
      expect(harness.seen.some((seen) => seen.method === "PATCH")).toBe(false);
    });

    test("y sends the change and prints the new values", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () => ({
          instance: inst({ settings: { createSession: false, spawnMode: "same-dir" } }),
          previous: inst().settings,
        }),
      });
      harness.env.readLine = () => Promise.resolve("y");
      const outcome = await harness.run("settings", ID, "--no-create-session");
      expect(outcome.code).toBe(0);
      expect(JSON.parse(defined(harness.seen.find((seen) => seen.method === "PATCH")).body)).toEqual({
        createSession: false,
      });
      expect(harness.out.at(-1)).toBe("changed: create-session off, spawn same-dir");
    });

    test("--yes skips the question", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () => ({
          instance: inst({ settings: { createSession: true, spawnMode: "worktree" } }),
          previous: inst().settings,
        }),
      });

      harness.env.readLine = () => {
        return Promise.reject(new Error("must not ask"));
      };

      const outcome = await harness.run("settings", ID, "--spawn", "worktree", "--yes");
      expect(outcome.code).toBe(0);
      expect(harness.out.at(-1)).toBe("changed: create-session on, spawn worktree");
    });

    test("a change on a paused instance (applied false) says it was only saved", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst({ state: "inactive" })],
        [`PATCH ${base}/${ID}`]: () => ({
          instance: inst({ state: "inactive", settings: { createSession: false, spawnMode: "same-dir" } }),
          previous: inst().settings,
          applied: false,
        }),
      });
      const outcome = await harness.run("settings", ID, "--no-create-session", "--yes");
      expect(outcome.code).toBe(0);
      expect(harness.out.slice(-2)).toEqual([
        "changed: create-session off, spawn same-dir",
        "Saved. The new settings start when you resume this folder. The node does not check them before then.",
      ]);
    });

    test("applied true prints no saved line", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () => ({ instance: inst(), previous: inst().settings, applied: true }),
      });
      await harness.run("settings", ID, "--no-create-session", "--yes");
      expect(harness.out.join("\n")).not.toContain("Saved.");
    });

    test("a lost answer (hub 502 or no connection) says the change may still run", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () => new Response(JSON.stringify({ error: "nas: unreachable" }), { status: 502 }),
      });
      const outcome = await harness.run("settings", ID, "--no-create-session", "--yes");
      expect(outcome.code).toBe(1);
      expect(harness.err).toEqual([
        "nas: unreachable. The answer did not come back. The change may still be running. Look at the instance list before you try again.",
      ]);
    });

    test("no connection to the hub on the change says the change may still run, and an expired login stays as it is", async () => {
      const mk = (fail: Error) =>
        ({
          request: (method: string) => {
            if (method === "GET") return Promise.resolve([inst()]);
            return Promise.reject(fail);
          },
        }) as unknown as HubClient;
      const flags = { "no-create-session": true, yes: true } as Flags;
      const lost = await runCommand(
        "settings",
        [ID],
        flags,
        mk(new ExitError("cannot reach http://hub: socket closed", 1)),
        () => {},
      ).then(
        () => undefined,
        (entry) => entry,
      );
      expect((lost as ExitError).message).toBe(
        "cannot reach http://hub: socket closed. The answer did not come back. The change may still be running. Look at the instance list before you try again.",
      );
      const login = await runCommand("settings", [ID], flags, mk(new ExitError(LOGIN_MESSAGE, 2)), () => {}).then(
        () => undefined,
        (entry) => entry,
      );
      expect([(login as ExitError).code, (login as ExitError).message]).toEqual([2, LOGIN_MESSAGE]);
    });

    test("a 409 with another code says another change runs and does not claim the old settings stay", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () =>
          new Response(JSON.stringify({ error: "operation in progress" }), { status: 409 }),
      });
      const outcome = await harness.run("settings", ID, "--no-create-session", "--yes");
      expect(outcome.code).toBe(1);
      expect(harness.err).toEqual([
        "Another change is running for this folder. Try again in a minute. Reason: operation in progress",
      ]);
    });

    test("a 409 settings_failed keeps its text", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () =>
          new Response(
            JSON.stringify({
              error: "it did not stay up",
              code: "settings_failed",
              settings: { createSession: true, spawnMode: "same-dir" },
            }),
            { status: 409 },
          ),
      });
      const outcome = await harness.run("settings", ID, "--no-create-session", "--yes");
      expect(outcome.code).toBe(1);
      expect(harness.err).toEqual(["it did not stay up. Settings stay: create-session on, spawn same-dir"]);
    });

    test("a 409 prints the reason and the old settings and exits 1", async () => {
      const harness = setup({
        [`GET ${base}`]: () => [inst()],
        [`PATCH ${base}/${ID}`]: () =>
          new Response(
            JSON.stringify({
              error: "a recoverable session exists\u001b[0m",
              code: "settings_refused",
              settings: { createSession: true, spawnMode: "same-dir" },
            }),
            { status: 409 },
          ),
      });
      const outcome = await harness.run("settings", ID, "--no-create-session", "--yes");
      expect(outcome.code).toBe(1);
      expect(harness.err.join("\n")).toBe(
        "a recoverable session exists?[0m. Settings stay: create-session on, spawn same-dir",
      );
    });
  });
});
