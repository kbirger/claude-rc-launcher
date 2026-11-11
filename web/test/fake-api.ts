// A fake hub API for browser checks and tests. In memory, one host ("local"), one user ("dev").
// `bun web/test/fake-api.ts` serves it on port 8080, where the Vite dev server proxies /api, /auth and /healthz.
// Failures can be set in code (`fail`) or over HTTP: POST /__fake/fail (a rule as JSON) and POST /__fake/reset.

export type FailRule = { match: string; status: number; body?: unknown; times?: number };
type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string };

const USER = "dev";
const HOME = "/home/dev";
// Folders the browse call lists. `untrusted` ones answer 428 on start until the request carries addTrust.
const DIRS: { name: string; trusted: boolean; kind?: "git" | "github" }[] = [
  { name: "proj-a", trusted: true, kind: "git" },
  { name: "proj-b", trusted: true },
  { name: "untrusted", trusted: false },
];
const REPOS = [
  { owner: "acme", repos: [{ name: "app", private: false, pushedAt: "2026-11-01T10:00:00Z" }, { name: "secret", private: true, pushedAt: "2026-10-20T10:00:00Z" }] },
  { owner: "dev", repos: [{ name: "dotfiles", private: false, pushedAt: "2026-09-02T10:00:00Z" }] },
];
const HOST = { id: "local", name: "local", status: "ok", version: "0.0.0-fake", platform: "linux" };
const READS_BEFORE_DONE = 2;

const json = (body: unknown, status = 200) => Response.json(body, { status });

export function startFakeApi(opts: { port?: number } = {}) {
  let rules: (FailRule & { left: number })[] = [];
  let instances: Instance[] = [];
  let trusted = new Set<string>();
  let clones = new Map<string, { path: string; reads: number }>();
  let logins = new Map<string, { reads: number }>();
  let loggedIn = false;
  let seq = 0;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const reset = () => {
    rules = [];
    instances = [];
    trusted = new Set(DIRS.filter((d) => d.trusted).map((d) => `${HOME}/${d.name}`));
    clones = new Map();
    logins = new Map();
    loggedIn = false;
    seq = 0;
  };
  reset();

  const enc = new TextEncoder();
  const events = () => {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setInterval>;
    const snapshot = { updates: [], logs: {}, presence: [{ host: "local", status: "online", version: HOST.version, at: new Date().toISOString() }] };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        streams.add(c);
        c.enqueue(enc.encode(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
        timer = setInterval(() => {
          try {
            c.enqueue(enc.encode(": keepalive\n\n"));
          } catch {
            clearInterval(timer);
          }
        }, 15000);
      },
      cancel() {
        streams.delete(ctl);
        clearInterval(timer);
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  };

  async function route(req: Request, url: URL): Promise<Response> {
    const method = req.method;
    const p = url.pathname;
    const body = method === "GET" || method === "DELETE" ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>);

    if (p === "/healthz") return json({ ok: true });
    if (p === "/api/me") return json({ sub: "fake", name: "Fake Dev", username: USER });
    if (p === "/api/events") return events();
    if (p === "/api/hosts") return json([HOST]);
    if (p === "/api/latest") return json({ version: HOST.version, checkedAt: new Date().toISOString() });
    if (p === "/api/updates") return json([]);
    if (p === "/api/updates/history") return json({});

    const m = /^\/api\/hosts\/([^/]+)\/(.*)$/.exec(p);
    if (!m) return json({ error: "not found" }, 404);
    if (decodeURIComponent(m[1]!) !== "local") return json({ error: "unknown host" }, 404);
    const rest = m[2]!.split("/").map(decodeURIComponent);
    const [a, b, c] = rest;

    if (a === "node") return json({ clone: true });
    if (a === "users") return json({ selectable: false, default: USER, users: [{ name: USER }] });
    if (a === "update" && method === "POST") return json({ status: "up-to-date", from: HOST.version });

    if (a === "instances") {
      if (!b && method === "GET") return json(instances);
      if (!b && method === "POST") {
        const path = String(body.path ?? "");
        if (!path) return json({ error: "path required" }, 400);
        if (!trusted.has(path)) {
          if (body.addTrust !== true) return json({ code: "untrusted", path, user: String(body.user ?? USER) }, 428);
          trusted.add(path);
        }
        const inst: Instance = { id: `i${++seq}`, path, name: body.name || path.split("/").pop() || path, state: "running", startedAt: new Date().toISOString(), user: String(body.user ?? USER) };
        instances.push(inst);
        return json(inst);
      }
      if (b && !c && method === "DELETE") {
        const n = instances.length;
        instances = instances.filter((i) => i.id !== b);
        return n === instances.length ? json({ error: "no such instance" }, 404) : new Response(null, { status: 204 });
      }
      if (b && c === "logs") return json({ log: `fake log for ${b}\nstarted\nready\n` });
    }

    if (a === "fs") {
      if (b === "mkdir" && method === "POST") {
        const parent = String(body.parent ?? HOME);
        const path = `${parent.replace(/\/$/, "")}/${body.name}`;
        trusted.add(path);
        return json({ path });
      }
      if (!b && method === "GET") {
        const path = url.searchParams.get("path") || HOME;
        if (path === HOME) return json({ path, parent: "/home", dirs: DIRS.map((d) => ({ name: d.name, path: `${HOME}/${d.name}`, trusted: trusted.has(`${HOME}/${d.name}`), ...(d.kind ? { kind: d.kind } : {}) })) });
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        return json({ path, parent, dirs: [] });
      }
    }

    if (a === "clone") {
      if (!b && method === "POST") {
        const id = `c${++seq}`;
        const path = `${String(body.parent ?? HOME).replace(/\/$/, "")}/${String(body.repo ?? "repo").split("/").pop()}`;
        clones.set(id, { path, reads: 0 });
        return json({ id, path });
      }
      if (b && method === "GET") {
        const job = clones.get(b);
        if (!job) return json({ error: "unknown job" }, 404);
        if (job.reads++ < READS_BEFORE_DONE) return json({ state: "running" });
        trusted.add(job.path);
        return json({ state: "done", path: job.path });
      }
    }

    if (a === "github") {
      if (b === "repos" && method === "GET") return loggedIn ? json({ groups: REPOS }) : json({ code: "github-login-required", error: "GitHub login required" }, 409);
      if (b === "login" && !c && method === "POST") {
        const id = `l${++seq}`;
        logins.set(id, { reads: 0 });
        return json({ id, code: "ABCD-1234", url: "https://github.com/login/device" });
      }
      if (b === "login" && c && method === "GET") {
        const job = logins.get(c);
        if (!job) return json({ error: "unknown job" }, 404);
        if (job.reads++ < READS_BEFORE_DONE) return json({ state: "pending" });
        loggedIn = true;
        return json({ state: "done" });
      }
    }
    return json({ error: "not found" }, 404);
  }

  const server = Bun.serve({
    port: opts.port ?? 8080,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__fake/reset" && req.method === "POST") {
        reset();
        return json({ ok: true });
      }
      if (url.pathname === "/__fake/fail" && req.method === "POST") {
        fail((await req.json()) as FailRule);
        return json({ ok: true });
      }
      const key = `${req.method} ${url.pathname}`;
      const hit = rules.find((r) => {
        const sp = r.match.indexOf(" ");
        return req.method === r.match.slice(0, sp) && url.pathname.includes(r.match.slice(sp + 1));
      });
      if (hit) {
        if (--hit.left <= 0) rules = rules.filter((r) => r !== hit);
        return json(hit.body ?? { error: `fake failure for ${key}` }, hit.status);
      }
      return route(req, url);
    },
  });

  function fail(rule: FailRule) {
    rules.push({ ...rule, left: rule.times ?? Infinity });
  }

  return {
    port: server.port as number,
    url: `http://localhost:${server.port}`,
    fail,
    reset,
    stop() {
      for (const c of streams) {
        try {
          c.close();
        } catch {}
      }
      streams.clear();
      void server.stop(true);
    },
  };
}

if (import.meta.main) {
  const api = startFakeApi();
  console.log(`fake hub API on ${api.url}`);
}
