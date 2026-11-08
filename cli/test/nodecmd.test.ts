import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../server/src/config";
import { saveCreds } from "../src/creds";
import { main, type Env } from "../src/index";
import { realNodeFs, renderNodeConfig, type NodeFs } from "../src/nodecmd";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const key = (n: number) => Buffer.alloc(32, n).toString("base64url"); // valid: 32 raw bytes
const enrollment = { hub_keys: [{ public_key: key(1) }, { public_key: key(2) }] };
const parse = (toml: string) => parseConfig(Bun.TOML.parse(toml), { readFile: () => "x" });

describe("renderNodeConfig", () => {
  const base = { hub: "https://rc.example.com", enrollment, listen: "10.0.0.9", port: 8443, names: ["pi.internal", "10.0.0.9"] };

  test("the output is a valid node configuration with the hub's values", () => {
    const cfg = parse(renderNodeConfig({ ...base, name: "pi", roots: ["/home/pi/projects"] }));
    expect(cfg.mode).toBe("node");
    expect(cfg).toMatchObject({ name: "pi", port: 8443, host: "10.0.0.9", roots: ["/home/pi/projects"] });
    expect(cfg.node!.tls).toEqual({ stateDir: "/var/lib/claude-rc-launcher", names: ["pi.internal", "10.0.0.9"] });
    expect(cfg.node!.auth.hubKeys).toEqual([key(1), key(2)]);
  });

  test("one [[node_auth.hub_key]] table per key, in order, and no oidc table", () => {
    const text = renderNodeConfig(base);
    expect(text.match(/^\[\[node_auth\.hub_key\]\]$/gm)).toHaveLength(2);
    expect(text).toContain(`public_key = "${key(1)}"`);
    expect(text.indexOf(key(1))).toBeLessThan(text.indexOf(key(2)));
    expect(text).not.toContain("node_auth.oidc");
    expect(text).toMatch(/hub key is a public key.*not secret/i);
  });

  test("a service user is written to [instance] and parses", () => {
    const cfg = parse(renderNodeConfig({ ...base, serviceUser: "kir", roots: ["/home/kir/p"] }));
    expect(cfg).toMatchObject({ serviceUser: "kir", serviceHome: "/home/kir", roots: ["/home/kir/p"] });
    const noRoots = parse(renderNodeConfig({ ...base, serviceUser: "kir" }));
    expect(noRoots.roots).toEqual(["/home/kir"]);
  });

  test("name and roots are left out when not given, so the defaults apply", () => {
    const text = renderNodeConfig(base);
    expect(text).not.toMatch(/^name\s*=/m);
    expect(text).not.toContain("[instance]");
    expect(parse(text).mode).toBe("node");
  });

  test("quotes, backslashes and newlines in values are escaped", () => {
    const cfg = parse(renderNodeConfig({ ...base, name: 'a"b\\c\nd', enrollment: { hub_keys: [{ public_key: key(3) }] } }));
    expect(cfg.name).toBe('a"b\\c\nd');
    expect(cfg.node!.auth.hubKeys).toEqual([key(3)]);
  });

  test("the header says where the file came from and has no placeholder text", () => {
    const text = renderNodeConfig(base);
    expect(text).toContain("https://rc.example.com");
    expect(text).not.toMatch(/replace-with|placeholder/i);
  });
});

type Seen = { method: string; path: string };
// Tests never touch /etc or run sudo: unless a test passes its own, every write goes to this fake.
const safeFs: NodeFs & { writes: string[] } = {
  writes: [],
  exists: () => false,
  write(p) {
    this.writes.push(p);
  },
  backup: () => {},
  sudoWrite: () => {
    throw new Error("a test ran sudo");
  },
  isRoot: () => true,
};

function setup(routes: Record<string, () => Response | unknown>, nodeFs: NodeFs = safeFs) {
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
  const env: Env = { credsFile, open: async () => {}, readLine: async () => "", nodeFs };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({ code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env) });
  return { seen, run, out, err };
}

const flagsOk = ["--listen", "10.0.0.9", "--names", "pi.internal,10.0.0.9"];

describe("claude-rc node config", () => {
  test("--output - prints a valid node configuration on stdout and nothing else", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    const r = await s.run("node", "config", ...flagsOk, "--name", "pi", "--roots", "/srv/a,/srv/b", "--output", "-");
    expect(r.code).toBe(0);
    expect(s.out).toHaveLength(1);
    const cfg = parse(s.out[0]!);
    expect(cfg).toMatchObject({ name: "pi", port: 8443, host: "10.0.0.9", roots: ["/srv/a", "/srv/b"] });
    expect(cfg.node!.tls.names).toEqual(["pi.internal", "10.0.0.9"]);
  });

  test("by default it writes the file itself and prints one status line, not instructions", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rc-out-"));
    const file = path.join(dir, "etc", "config.toml");
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment }, realNodeFs);
    const r = await s.run("node", "config", ...flagsOk, "--output", file);
    expect(r.code).toBe(0);
    expect(parse(readFileSync(file, "utf8")).mode).toBe("node");
    expect(s.out).toEqual([`wrote ${file}`]);
    expect(s.err).toEqual([]);
  });

  test("the default path is /etc/claude-rc-launcher/config.toml", async () => {
    const writes: string[] = [];
    const nodeFs: NodeFs = { exists: () => false, write: (p) => void writes.push(p), backup: () => {}, sudoWrite: () => { throw new Error("no sudo"); }, isRoot: () => true };
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment }, nodeFs);
    await s.run("node", "config", ...flagsOk);
    expect(writes).toEqual(["/etc/claude-rc-launcher/config.toml"]);
  });

  test("an existing file is refused without --force and left unchanged", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-out-")), "config.toml");
    writeFileSync(file, "old\n");
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment }, realNodeFs);
    const r = await s.run("node", "config", ...flagsOk, "--output", file);
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("--force");
    expect(readFileSync(file, "utf8")).toBe("old\n");
    expect(s.seen).toHaveLength(0);
  });

  test("--force replaces the file and keeps the old one as .bak", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-out-")), "config.toml");
    writeFileSync(file, "old\n");
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment }, realNodeFs);
    expect((await s.run("node", "config", ...flagsOk, "--output", file, "--force")).code).toBe(0);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("old\n");
    expect(parse(readFileSync(file, "utf8")).mode).toBe("node");
  });

  test("when the file cannot be written and the user is not root, it writes through sudo", async () => {
    const sudo: { path: string; text: string }[] = [];
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const nodeFs: NodeFs = { exists: () => false, write: () => { throw eacces; }, backup: () => {}, sudoWrite: (p, t) => void sudo.push({ path: p, text: t }), isRoot: () => false };
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment }, nodeFs);
    const r = await s.run("node", "config", ...flagsOk, "--output", "/etc/claude-rc-launcher/config.toml");
    expect(r.code).toBe(0);
    expect(sudo).toHaveLength(1);
    expect(sudo[0]!.path).toBe("/etc/claude-rc-launcher/config.toml");
    expect(parse(sudo[0]!.text).mode).toBe("node");
    expect(s.out).toEqual(["wrote /etc/claude-rc-launcher/config.toml (with sudo)"]);
  });

  test("as root a write error is reported and sudo is not tried", async () => {
    const eacces = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    const nodeFs: NodeFs = { exists: () => false, write: () => { throw eacces; }, backup: () => {}, sudoWrite: () => { throw new Error("must not run sudo"); }, isRoot: () => true };
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment }, nodeFs);
    const r = await s.run("node", "config", ...flagsOk);
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("EROFS");
  });

  test("an old hub (oidc, no hub_keys), an empty hub_keys or a bad entry is refused and nothing is written", async () => {
    const bad: Record<string, unknown> = {
      "old hub": { oidc: { issuer: "https://idp.example.com", client_id: "c" } },
      "empty hub_keys": { hub_keys: [] },
      "entry without public_key": { hub_keys: [{ public_key: key(1) }, {}] },
    };
    for (const [name, body] of Object.entries(bad)) {
      const nodeFs: NodeFs = { exists: () => false, write: () => { throw new Error("must not write"); }, backup: () => {}, sudoWrite: () => { throw new Error("must not run sudo"); }, isRoot: () => true };
      const s = setup({ "GET /cli/api/node-enrollment": () => body }, nodeFs);
      const r = await s.run("node", "config", ...flagsOk);
      expect([name, r.code]).toEqual([name, 1]);
      expect(s.err.join("\n")).toContain("the hub did not return a hub key. Upgrade the hub to a version that supports hub keys.");
      expect(s.out).toEqual([]);
    }
  });

  test("a stray argument is refused, because a space after a comma in --names splits it", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    const r = await s.run("node", "config", "--listen", "10.0.0.9", "--names", "pi.internal,", "10.0.0.1", "--output", "-");
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("unexpected argument");
    expect(s.err[0]).toContain("10.0.0.1");
    expect(s.err[0]).toContain("comma");
    expect(s.seen).toHaveLength(0);
  });

  test("the listen address is added to the certificate names when it is an IP that is missing", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    await s.run("node", "config", "--listen", "192.168.1.111", "--names", "kirhub", "--output", "-");
    expect(parse(s.out[0]!).node!.tls.names).toEqual(["kirhub", "192.168.1.111"]);
    s.out.length = 0;
    await s.run("node", "config", "--listen", "192.168.1.111", "--names", "192.168.1.111,kirhub", "--output", "-");
    expect(parse(s.out[0]!).node!.tls.names).toEqual(["192.168.1.111", "kirhub"]);
  });

  test("a hostname or wildcard listen address is not added to the names", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    await s.run("node", "config", "--listen", "0.0.0.0", "--names", "kirhub", "--output", "-");
    expect(parse(s.out[0]!).node!.tls.names).toEqual(["kirhub"]);
    s.out.length = 0;
    await s.run("node", "config", "--listen", "kirhub.lan", "--names", "kirhub", "--output", "-");
    expect(parse(s.out[0]!).node!.tls.names).toEqual(["kirhub"]);
  });

  test("a name with a space or an invalid character is refused", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    for (const names of ["a b", "x/y", "ok,bad name"]) {
      expect([names, (await s.run("node", "config", "--listen", "10.0.0.9", "--names", names, "--output", "-")).code]).toEqual([names, 1]);
    }
    expect(s.seen).toHaveLength(0);
  });

  test("--names is optional when --listen is an IP address, because the certificate then covers that address", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    expect((await s.run("node", "config", "--listen", "192.168.1.111", "--output", "-")).code).toBe(0);
    expect(parse(s.out[0]!).node!.tls.names).toEqual(["192.168.1.111"]);
  });

  test("--port overrides the default", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    await s.run("node", "config", ...flagsOk.slice(0, 2), "--names", "pi", "--port", "9443", "--output", "-");
    expect(parse(s.out[0]!).port).toBe(9443);
  });

  test("missing or bad flags exit 1 and send nothing", async () => {
    const s = setup({ "GET /cli/api/node-enrollment": () => enrollment });
    const bad = [
      ["node", "config", "--names", "pi"],
      ["node", "config", "--listen", "0.0.0.0"],
      ["node", "config", "--listen", "kirhub.lan"],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--port", "99999"],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--port", "abc"],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--roots", "relative/dir"],
      ["node", "config", "--listen", "10.0.0.9", "--names", "pi", "--output", "relative/config.toml"],
      ["node", "bogus"],
      ["node"],
    ];
    for (const argv of bad) expect([argv.join(" "), (await s.run(...argv)).code]).toEqual([argv.join(" "), 1]);
    expect(s.seen).toHaveLength(0);
    expect(s.out).toHaveLength(0);
  });

  test("a hub error prints its text on stderr and writes nothing", async () => {
    const writes: string[] = [];
    const nodeFs: NodeFs = { exists: () => false, write: (p) => void writes.push(p), backup: () => {}, sudoWrite: () => {}, isRoot: () => true };
    const s = setup({ "GET /cli/api/node-enrollment": () => Response.json({ error: "the hub is not ready" }, { status: 400 }) }, nodeFs);
    const r = await s.run("node", "config", ...flagsOk);
    expect(r.code).toBe(1);
    expect(s.err[0]).toContain("the hub is not ready");
    expect(s.out).toHaveLength(0);
    expect(writes).toEqual([]);
  });
});
