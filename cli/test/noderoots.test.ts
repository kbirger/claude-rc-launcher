import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExitError } from "../src/creds";
import { main, type Env } from "../src/index";
import type { Sys } from "../src/nodesetup";
import { addRoot, effectiveRoots, normalizeRoot, removeRoot, renderChecked } from "../src/noderoots";

describe("pure functions", () => {
  test("effectiveRoots falls back to the home of the service user", () => {
    expect(effectiveRoots({})).toEqual({ roots: ["/root"], implicit: true });
    expect(effectiveRoots({ instance: { service_user: "dev" } })).toEqual({ roots: ["/home/dev"], implicit: true });
  });

  test("effectiveRoots returns the configured roots", () => {
    expect(effectiveRoots({ instance: { service_home: "/srv/h", roots: ["/a"] } })).toEqual({
      roots: ["/a"],
      implicit: false,
    });
  });

  test("effectiveRoots uses service_home when there are no roots", () => {
    expect(effectiveRoots({ instance: { service_home: "/srv/h" } })).toEqual({ roots: ["/srv/h"], implicit: true });
  });

  test("normalizeRoot removes a trailing slash and keeps the root", () => {
    expect(normalizeRoot("/srv/p/")).toBe("/srv/p");
    expect(normalizeRoot("/")).toBe("/");
  });

  test("normalizeRoot rejects an empty, relative or .. path", () => {
    for (const bad of ["", "srv", "/a/../b"]) expect(() => normalizeRoot(bad)).toThrow(ExitError);
  });

  test("addRoot keeps the default root as the first root", () => {
    const result = addRoot({ instance: { service_user: "dev" } }, "/srv/p");
    expect(result.roots).toEqual(["/home/dev", "/srv/p"]);
    expect(result.seeded).toBe("/home/dev");
    expect(result.changed).toBe(true);
    expect(result.cfg).toEqual({ instance: { service_user: "dev", roots: ["/home/dev", "/srv/p"] } });
  });

  test("addRoot of an existing root changes nothing", () => {
    const cfg = { instance: { roots: ["/a", "/b"] } };
    const result = addRoot(cfg, "/b/");
    expect(result.changed).toBe(false);
    expect(result.cfg).toEqual(cfg);
    expect(result.seeded).toBeUndefined();
  });

  test("addRoot does not change its input", () => {
    const cfg = { instance: { roots: ["/a"] } };
    addRoot(cfg, "/b");
    expect(cfg).toEqual({ instance: { roots: ["/a"] } });
  });

  test("removeRoot refuses a folder that is not a root", () => {
    expect(() => removeRoot({ instance: { roots: ["/a", "/b"] } }, "/c")).toThrow(ExitError);
  });

  test("removeRoot refuses the last root", () => {
    expect(() => removeRoot({ instance: { roots: ["/a"] } }, "/a")).toThrow(ExitError);
  });

  test("removeRoot keeps the other root", () => {
    const result = removeRoot({ instance: { roots: ["/a", "/b"] } }, "/a");
    expect(result.roots).toEqual(["/b"]);
    expect(result.cfg).toEqual({ instance: { roots: ["/b"] } });
  });

  test("removeRoot can remove the default root once another root exists", () => {
    const added = addRoot({}, "/srv/p");
    expect(removeRoot(added.cfg, "/root").roots).toEqual(["/srv/p"]);
  });

  test("a root in the file that holds .. does not block add or remove", () => {
    const cfg = { instance: { roots: ["/srv/../opt", "/b"] } };
    expect(addRoot(cfg, "/x").roots).toEqual(["/srv/../opt", "/b", "/x"]);
    expect(removeRoot(cfg, "/b").roots).toEqual(["/srv/../opt"]);
    expect(removeRoot(cfg, "/opt").roots).toEqual(["/b"]);
    expect(addRoot(cfg, "/opt").changed).toBe(false);
  });

  test("renderChecked keeps the other tables of the file", () => {
    const before = {
      mode: "node",
      tls: { names: ["a.internal"] },
      node_auth: { hub_key: [{ public_key: "k1" }, { public_key: "k2" }] },
    };
    const after = { ...before, instance: { roots: ["/a"] } };
    const text = renderChecked(before, after);
    expect(Bun.TOML.parse(text)).toEqual(after);
  });

  test("renderChecked refuses a change outside instance.roots", () => {
    const before = { tls: { names: ["a.internal"] }, instance: { roots: ["/a"] } };
    const after = { tls: { names: ["b.internal"] }, instance: { roots: ["/a", "/b"] } };
    expect(() => renderChecked(before, after)).toThrow(ExitError);
  });
});

const CONFIG = "/etc/claude-rc-launcher/config.toml";
const BASE = [
  'mode = "node"',
  "",
  "[instance]",
  'service_user = "dev"',
  "",
  "[tls]",
  'names = ["10.0.0.9"]',
  "",
  "[[node_auth.hub_key]]",
  'public_key = "k1"',
  "",
].join("\n");

function fake(
  files: Record<string, string> = { [CONFIG]: BASE },
  opts: { platform?: string; noSystemctl?: boolean; failRestart?: boolean; inactive?: boolean } = {},
) {
  const calls: string[] = [];
  let clock = 0;
  const store = { ...files };
  const sys: Sys = {
    platform: opts.platform ?? "linux",
    arch: "x64",
    isRoot: () => false,
    hasCommand: (n) => !(opts.noSystemctl && n === "systemctl"),
    localAddresses: () => [],
    exists: (p) => p in store,
    run(args) {
      calls.push(`run ${args.join(" ")}`);
      return { code: opts.inactive && args[1] === "is-active" ? 3 : 0, stdout: "" };
    },
    sudo(args, input) {
      calls.push(args.join(" "));
      if (args[0] === "tee") store[args[1]!] = String(input);
      if (args[0] === "cp") store[args[3]!] = store[args[2]!] ?? "";
      if (args[0] === "systemctl" && opts.failRestart) return { code: 1, stdout: "", stderr: "boom" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => new TextEncoder().encode(store[p] ?? ""),
    writeTemp: () => "",
    removeTemp: () => {},
    fetch: (() => {
      throw new Error("no network");
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => (clock += 1000),
  };
  const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-roots-")), "none.json");
  const env: Env = { credsFile, open: async () => {}, readLine: async () => "", sys };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => ({
    code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env),
  });
  return { run, out, err, calls, store };
}

const rootsOf = (text: string | undefined) =>
  (Bun.TOML.parse(text ?? "") as { instance?: { roots?: string[] } }).instance?.roots;
const ONE = 'mode = "node"\n[instance]\nroots = ["/a"]\n';
const TWO = 'mode = "node"\n[instance]\nroots = ["/a", "/b"]\n';

describe("node roots command", () => {
  test("list prints the roots, marks the default and prints JSON", async () => {
    const roots = fake({ [CONFIG]: TWO });
    expect((await roots.run("node", "roots", "list")).code).toBe(0);
    expect(roots.out).toEqual(["/a", "/b"]);
    const json = fake({ [CONFIG]: TWO });
    await json.run("node", "roots", "list", "--json");
    expect(json.out).toEqual(['["/a","/b"]']);
    const none = fake({ [CONFIG]: 'mode = "node"\n' });
    await none.run("node", "roots", "list");
    expect(none.out).toEqual(["/root (default)"]);
    expect(none.calls).toEqual([]);
  });

  test("the first add keeps the default root, writes a backup, writes the file and restarts", async () => {
    const t = fake();
    expect((await t.run("node", "roots", "add", "/srv/p")).code).toBe(0);
    expect(t.out).toContain("roots was not set: kept /home/dev as the first root");
    expect(t.out).toContain(`added /srv/p to the roots of ${CONFIG}`);
    expect(rootsOf(t.store[CONFIG])).toEqual(["/home/dev", "/srv/p"]);
    expect((Bun.TOML.parse(t.store[CONFIG]!) as { tls: unknown }).tls).toEqual({ names: ["10.0.0.9"] });
    expect(t.store[`${CONFIG}.bak`]).toBe(BASE);
    expect(t.calls.filter((c) => !c.startsWith("run "))).toEqual([
      `cp -p ${CONFIG} ${CONFIG}.bak`,
      `tee ${CONFIG}`,
      "systemctl restart claude-rc-launcher",
    ]);
  });

  test("add of an existing root changes nothing", async () => {
    const t = fake({ [CONFIG]: ONE });
    expect((await t.run("node", "roots", "add", "/a/")).code).toBe(0);
    expect(t.out).toEqual(["/a is already a root"]);
    expect(t.calls).toEqual([]);
  });

  test("remove of the last root exits 1 and writes nothing", async () => {
    const t = fake({ [CONFIG]: ONE });
    expect((await t.run("node", "roots", "remove", "/a")).code).toBe(1);
    expect(t.calls).toEqual([]);
  });

  test("remove drops one root and restarts", async () => {
    const t = fake({ [CONFIG]: TWO });
    expect((await t.run("node", "roots", "remove", "/a")).code).toBe(0);
    expect(t.out).toEqual([`removed /a from the roots of ${CONFIG}`]);
    expect(rootsOf(t.store[CONFIG])).toEqual(["/b"]);
    expect(t.calls).toContain("systemctl restart claude-rc-launcher");
  });

  test("--no-restart skips the restart and prints a reminder", async () => {
    const t = fake();
    expect((await t.run("node", "roots", "add", "/srv/p", "--no-restart")).code).toBe(0);
    expect(t.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
    expect(t.out).toContain("the service was not restarted. Run: sudo systemctl restart claude-rc-launcher");
  });

  test("a failing restart exits 1 and says that the file was changed", async () => {
    const t = fake(undefined, { failRestart: true });
    expect((await t.run("node", "roots", "add", "/srv/p")).code).toBe(1);
    expect(t.err.join("\n")).toContain("was changed, but the service did not restart");
    expect(rootsOf(t.store[CONFIG])).toEqual(["/home/dev", "/srv/p"]);
  });

  test("a service that does not stay active after the restart exits 1 and points to the backup", async () => {
    const t = fake(undefined, { inactive: true });
    expect((await t.run("node", "roots", "add", "/srv/p")).code).toBe(1);
    expect(t.err.join("\n")).toContain(`did not become active and stay active`);
    expect(t.err.join("\n")).toContain(`${CONFIG}.bak`);
    expect(t.calls).toContain("journalctl -u claude-rc-launcher -n 15 --no-pager");
  });

  test("a healthy restart checks that the service is active", async () => {
    const t = fake();
    expect((await t.run("node", "roots", "add", "/srv/p")).code).toBe(0);
    expect(t.calls).toContain("run systemctl is-active claude-rc-launcher");
  });

  test("a missing file exits 1, and --config reads another file", async () => {
    const t = fake({ "/tmp/x.toml": 'mode = "node"\n[instance]\nroots = ["/z"]\n' });
    expect((await t.run("node", "roots", "list")).code).toBe(1);
    expect(t.err.join("\n")).toContain("no node configuration at");
    expect((await t.run("node", "roots", "list", "--config", "/tmp/x.toml")).code).toBe(0);
    expect(t.out).toEqual(["/z"]);
  });

  test("a wrong command prints the usage and exits 1", async () => {
    const t = fake();
    for (const args of [["add"], ["add", "/a", "/b"], ["nope"], []]) {
      expect((await t.run("node", "roots", ...args)).code).toBe(1);
    }
    expect(t.err.join("\n")).toContain("usage: claude-rc node roots list | add <dir> | remove <dir>");
    expect((await t.run("node", "roots", "list", "--url", "x")).code).toBe(1);
    expect(t.err.join("\n")).toContain("does not apply");
    expect(t.calls).toEqual([]);
  });

  test("a relative folder is rejected before the file is touched", async () => {
    const t = fake();
    expect((await t.run("node", "roots", "add", "srv/p")).code).toBe(1);
    expect(t.calls).toEqual([]);
  });

  test("it works on Linux only, and add needs systemctl", async () => {
    const mac = fake(undefined, { platform: "darwin" });
    expect((await mac.run("node", "roots", "list")).code).toBe(1);
    const nosys = fake(undefined, { noSystemctl: true });
    expect((await nosys.run("node", "roots", "add", "/srv/p")).code).toBe(1);
    expect((await nosys.run("node", "roots", "add", "/srv/p", "--no-restart")).code).toBe(0);
  });
});
