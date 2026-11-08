import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../server/src/config";
import { ensureNodeCert } from "../../server/src/tls";
import { ExitError } from "../src/creds";
import type { HubClient } from "../src/hub";
import { UNIT, nodeSetup, realSys, type Sys } from "../src/nodesetup";

const CONFIG = "/etc/claude-rc-launcher/config.toml";
const UNIT_PATH = "/etc/systemd/system/claude-rc-launcher.service";
const BIN = "/usr/local/bin/claude-rc-launcher";
const CERT = "/var/lib/claude-rc-launcher/node-cert.pem";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const enrollment = { hub_keys: [{ public_key: KEY }] };
const ASSET = "claude-rc-launcher-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const BINARY = new TextEncoder().encode("#!fake-binary");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const parse = (toml: string) => parseConfig(Bun.TOML.parse(toml), { readFile: () => "x" });

let certPem = "";
let fingerprint = "";
beforeAll(async () => {
  const c = await ensureNodeCert({ dir: mkdtempSync(path.join(os.tmpdir(), "rc-setup-")), names: ["192.168.1.111"] });
  certPem = c.certPem;
  fingerprint = `sha256:${createHash("sha256").update(new X509Certificate(c.certPem).raw).digest("hex")}`;
});

type World = { calls: string[]; written: Map<string, string | Uint8Array>; fetched: string[]; started: boolean };

function fake(o: { existing?: string[]; active?: boolean; users?: string[]; platform?: string; arch?: string; addresses?: string[]; sums?: string; healthy?: boolean; root?: boolean; files?: Record<string, string> } = {}) {
  const w: World = { calls: [], written: new Map(), fetched: [], started: false };
  const existing = new Set(o.existing ?? []);
  let clock = 0;
  const sys: Sys = {
    platform: o.platform ?? "linux",
    arch: o.arch ?? "x64",
    isRoot: () => o.root ?? false,
    hasCommand: (n) => n !== "missing-cmd",
    localAddresses: () => o.addresses ?? ["127.0.0.1", "192.168.1.111"],
    exists: (p) => existing.has(p),
    run(args) {
      w.calls.push(`run ${args.join(" ")}`);
      if (args[0] === "systemctl" && args[1] === "is-active") return { code: o.active ? 0 : 3, stdout: o.active ? "active" : "inactive" };
      if (args[0] === "id") return { code: (o.users ?? ["kir"]).includes(args[2]!) ? 0 : 1, stdout: "" };
      return { code: 0, stdout: "" };
    },
    sudo(args, input) {
      w.calls.push(`sudo ${args.join(" ")}`);
      if (args[0] === "tee") w.written.set(args[1]!, input ?? "");
      if (args[0] === "systemctl" && args[1] === "enable") w.started = true;
      if (args[0] === "cat" && args[1] === CERT) return w.started ? { code: 0, stdout: certPem, stderr: "" } : { code: 1, stdout: "", stderr: "no such file" };
      if (args[0] === "journalctl") return { code: 0, stdout: "Nov 07 node[1]: startup failed: port in use", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => new TextEncoder().encode(o.files?.[p] ?? ""),
    writeTemp(name, data) {
      const p = `/tmp/fake/${name}`;
      w.written.set(p, data);
      return p;
    },
    removeTemp: (p) => void w.calls.push(`rm ${p}`),
    fetch: (async (url: string | URL) => {
      const u = String(url);
      w.fetched.push(u);
      if (u === `${RELEASE}/latest/download/${ASSET}` || u === `${RELEASE}/download/v0.1.0/${ASSET}`) return new Response(BINARY);
      if (u.endsWith("/SHA256SUMS")) return new Response(o.sums ?? `${sha(BINARY)}  ${ASSET}\n${"0".repeat(64)}  claude-rc-linux-x64\n`);
      if (/^https:\/\/[^/]+\/healthz$/.test(u)) {
        if (!w.started || o.healthy === false) throw new Error("ECONNREFUSED");
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { sys, w };
}

function fakeHub(fail?: string, enroll: unknown = enrollment) {
  const requests: { method: string; path: string; body?: any }[] = [];
  const hub = {
    request: async (method: string, p: string, body?: unknown) => {
      requests.push({ method, path: p, body });
      if (p === "/cli/api/node-enrollment") return enroll;
      if (fail) throw new ExitError(fail, 1);
      return { id: "kirhub", source: "managed" };
    },
  } as unknown as HubClient;
  return { hub, requests };
}

const base = { hubUrl: "https://rc.example.com", flags: { listen: "192.168.1.111", name: "kirhub" } as any };
async function run(sys: Sys, hub: HubClient, flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  await nodeSetup({ ...base, flags: { ...base.flags, ...flags }, hub, out: (s) => out.push(s), sys });
  return out;
}
const fails = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as ExitError | undefined;

describe("nodeSetup", () => {
  test("the happy path installs, starts and registers, in order", async () => {
    const { sys, w } = fake();
    const { hub, requests } = fakeHub();
    const out = await run(sys, hub, { roots: "/home/kir/p", "service-user": "kir" });
    const order = ["install -m 755 /tmp/fake/", "mv -f", "mkdir -p /etc/claude-rc-launcher", `tee ${CONFIG}`, `tee ${UNIT_PATH}`, "systemctl daemon-reload", "systemctl enable --now claude-rc-launcher"];
    const sudoCalls = w.calls.filter((c) => c.startsWith("sudo ")).map((c) => c.slice(5));
    let at = -1;
    for (const step of order) {
      const i = sudoCalls.findIndex((c, idx) => idx > at && c.startsWith(step));
      expect([step, i > at]).toEqual([step, true]);
      at = i;
    }
    // The enrollment is fetched before any privileged call, and registration comes last.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /cli/api/node-enrollment", "POST /cli/api/hosts"]);
    expect(w.calls.findIndex((c) => c.startsWith("sudo "))).toBeGreaterThanOrEqual(0);
    expect(requests[1]!.body).toEqual({ id: "kirhub", name: "kirhub", url: "https://192.168.1.111:8443", fingerprint });
    expect(out.join("\n")).toContain(fingerprint);
    expect(out.join("\n")).toContain("claude-rc host remove kirhub");
  });

  test("the written config is a valid node config with the hub's values and the service user", async () => {
    const { sys, w } = fake();
    await run(sys, fakeHub().hub, { roots: "/home/kir/p", "service-user": "kir", names: "kirhub" });
    const cfg = parse(String(w.written.get(CONFIG)));
    expect(cfg).toMatchObject({ mode: "node", name: "kirhub", port: 8443, host: "192.168.1.111", serviceUser: "kir", roots: ["/home/kir/p"] });
    expect(cfg.node!.tls.names).toEqual(["kirhub", "192.168.1.111"]);
    expect(cfg.node!.auth.hubKeys).toEqual([KEY]);
  });

  describe("the certificate covers the host in --url", () => {
    const namesOf = async (flags: Record<string, unknown>, addresses?: string[]) => {
      const { sys, w } = fake(addresses ? { addresses } : {});
      await run(sys, fakeHub().hub, flags);
      return parse(String(w.written.get(CONFIG))).node!.tls.names;
    };
    test("a DNS name in --url is added next to the listen address and --names", async () => {
      expect(await namesOf({ url: "https://node.lan:8443" })).toEqual(["192.168.1.111", "node.lan"]);
      expect(await namesOf({ url: "https://node.lan:8443", names: "kirhub" })).toEqual(["kirhub", "192.168.1.111", "node.lan"]);
    });
    test("a wildcard listen needs no --names when --url names the host", async () => {
      expect(await namesOf({ listen: "0.0.0.0", url: "https://node.lan:8443" }, ["0.0.0.0"])).toEqual(["node.lan"]);
    });
    test("a wildcard listen with other --names still gets the --url host", async () => {
      expect(await namesOf({ listen: "0.0.0.0", url: "https://node.lan:8443", names: "10.0.0.5" }, ["0.0.0.0"])).toEqual(["10.0.0.5", "node.lan"]);
    });
    test("a host that is already listed is not added twice, whatever its case", async () => {
      expect(await namesOf({ url: "https://Node.LAN:8443", names: "node.lan" })).toEqual(["node.lan", "192.168.1.111"]);
      expect(await namesOf({ url: "https://192.168.1.111:8443" })).toEqual(["192.168.1.111"]);
    });
    test("an IPv6 address in --url is added without its brackets", async () => {
      expect(await namesOf({ url: "https://[fd00::1]:8443" })).toEqual(["192.168.1.111", "fd00::1"]);
    });
    test("an invalid --url still gives the --url error", async () => {
      expect((await fails(run(fake().sys, fakeHub().hub, { url: "not a url" })))?.message).toContain("--url is not a valid URL");
    });
  });

  test("the unit is the shipped unit", async () => {
    expect(UNIT).toBe(readFileSync(path.join(import.meta.dir, "../../deploy/claude-rc-launcher.service"), "utf8"));
    const { sys, w } = fake();
    await run(sys, fakeHub().hub);
    expect(w.written.get(UNIT_PATH)).toBe(UNIT);
  });

  test("the binary is downloaded from the release, checked against SHA256SUMS and installed under a temporary name", async () => {
    const { sys, w } = fake({ arch: "arm64", sums: `${sha(BINARY)}  claude-rc-launcher-linux-arm64\n` });
    const s2 = { ...sys, fetch: (async (u: string) => (String(u).endsWith("linux-arm64") ? new Response(BINARY) : (sys.fetch as any)(u))) as unknown as typeof fetch };
    await run(s2, fakeHub().hub);
    expect(w.calls).toContain(`sudo install -m 755 /tmp/fake/claude-rc-launcher ${BIN}.new`);
    expect(w.calls).toContain(`sudo mv -f ${BIN}.new ${BIN}`);
    expect(w.calls.some((c) => c.startsWith("rm /tmp/fake/"))).toBe(true);
  });

  test("--release picks that release", async () => {
    const { sys, w } = fake();
    await run(sys, fakeHub().hub, { release: "v0.1.0" });
    expect(w.fetched).toContain(`${RELEASE}/download/v0.1.0/${ASSET}`);
  });

  test("a checksum mismatch stops before any change", async () => {
    const { sys, w } = fake({ sums: `${"1".repeat(64)}  ${ASSET}\n` });
    const e = await fails(run(sys, fakeHub().hub));
    expect(e?.message).toContain("checksum");
    expect(w.calls.filter((c) => c.startsWith("sudo "))).toEqual([]);
  });

  test("--binary installs that file and downloads nothing", async () => {
    const { sys, w } = fake({ files: { "/opt/build/claude-rc-launcher": "local-binary" } });
    await run(sys, fakeHub().hub, { binary: "/opt/build/claude-rc-launcher" });
    expect(w.fetched.filter((u) => u.includes("github.com"))).toEqual([]);
    expect(new TextDecoder().decode(w.written.get("/tmp/fake/claude-rc-launcher") as Uint8Array)).toBe("local-binary");
  });

  test("existing files or a running service are refused without --force, before any request", async () => {
    for (const o of [{ existing: [CONFIG] }, { existing: [UNIT_PATH] }, { active: true }]) {
      const { sys, w } = fake(o);
      const { hub, requests } = fakeHub();
      const e = await fails(run(sys, hub));
      expect(e?.message).toContain("--force");
      expect(requests).toHaveLength(0);
      expect(w.calls.filter((c) => c.startsWith("sudo "))).toEqual([]);
    }
  });

  test("--force keeps the old config and unit as .bak", async () => {
    const { sys, w } = fake({ existing: [CONFIG, UNIT_PATH], active: true });
    await run(sys, fakeHub().hub, { force: true });
    expect(w.calls).toContain(`sudo cp -p ${CONFIG} ${CONFIG}.bak`);
    expect(w.calls).toContain(`sudo cp -p ${UNIT_PATH} ${UNIT_PATH}.bak`);
  });

  test("checks that fail before any request: not linux, no systemctl, unsupported arch, foreign address, wildcard, unknown user", async () => {
    const cases: [string, Parameters<typeof fake>[0], Record<string, unknown>, string][] = [
      ["not linux", { platform: "darwin" }, {}, "Linux"],
      ["unsupported arch", { arch: "ia32" }, {}, "architecture"],
      ["foreign address", { addresses: ["10.0.0.5"] }, {}, "192.168.1.111"],
      ["wildcard without --url", { addresses: ["0.0.0.0"] }, { listen: "0.0.0.0" }, "--url"],
      ["unknown user", {}, { "service-user": "nobody-here" }, "nobody-here"],
    ];
    for (const [name, o, flags, text] of cases) {
      const { sys, w } = fake(o);
      const { hub, requests } = fakeHub();
      const e = await fails(run(sys, hub, flags));
      expect([name, e?.message.includes(text)]).toEqual([name, true]);
      expect(requests).toHaveLength(0);
      expect(w.calls.filter((c) => c.startsWith("sudo "))).toEqual([]);
    }
    const noSystemctl = fake();
    noSystemctl.sys.hasCommand = () => false;
    expect((await fails(run(noSystemctl.sys, fakeHub().hub)))?.message).toContain("systemctl");
  });

  test("an old hub (oidc, no hub_keys) or an empty hub_keys is refused before anything is written", async () => {
    for (const [name, enroll] of [["old hub", { oidc: { issuer: "https://idp.example.com" } }], ["empty hub_keys", { hub_keys: [] }]] as const) {
      const { sys, w } = fake();
      const { hub, requests } = fakeHub(undefined, enroll);
      const e = await fails(run(sys, hub));
      expect([name, e?.message]).toEqual([name, "the hub did not return a hub key. Upgrade the hub to a version that supports hub keys."]);
      expect(e?.code).toBe(1);
      expect(requests.map((r) => r.path)).toEqual(["/cli/api/node-enrollment"]);
      expect(w.calls.filter((c) => c.startsWith("sudo "))).toEqual([]);
      expect(w.written.size).toBe(0);
      expect(w.fetched).toEqual([]);
    }
  });

  test("a node that never becomes healthy prints the journal and does not register", async () => {
    const { sys } = fake({ healthy: false });
    const { hub, requests } = fakeHub();
    const e = await fails(run(sys, hub));
    expect(e?.message).toContain("did not become healthy");
    expect(e?.message).toContain("startup failed: port in use");
    expect(requests.map((r) => r.path)).toEqual(["/cli/api/node-enrollment"]);
  });

  test("a registration failure leaves the node running and prints the retry command", async () => {
    const { sys, w } = fake();
    const e = await fails(run(sys, fakeHub("host kirhub: rejected our credentials").hub));
    expect(e?.message).toContain("rejected our credentials");
    expect(e?.message).toContain("claude-rc host add kirhub --url https://192.168.1.111:8443 --fingerprint " + fingerprint);
    expect(w.calls.some((c) => c.includes("systemctl stop") || c.includes("systemctl disable"))).toBe(false);
  });

  test("the host id comes from --id, else from --name, and a bad one is refused", async () => {
    const a = fakeHub();
    await run(fake().sys, a.hub, { id: "pi-1", name: "Pi One" });
    expect(a.requests[1]!.body).toMatchObject({ id: "pi-1", name: "Pi One" });
    const b = fakeHub();
    await run(fake().sys, b.hub, { name: "Kir Hub!" });
    expect(b.requests[1]!.body.id).toBe("kir-hub");
    expect((await fails(run(fake().sys, fakeHub().hub, { id: "Bad_Id" })))?.message).toContain("--id");
  });

  test("the real sys runs privileged commands directly as root, and passes input and output through", () => {
    if (process.getuid?.() !== 0) return;
    const r = realSys.sudo(["cat"], "from stdin");
    expect(r).toMatchObject({ code: 0, stdout: "from stdin" });
    expect(realSys.sudo(["false"]).code).not.toBe(0);
  });

  test("a missing claude for the service user is a warning, not an error", async () => {
    const { sys } = fake();
    const out = await run(sys, fakeHub().hub, { "service-user": "kir" });
    expect(out.join("\n")).toMatch(/warning: .*claude/);
  });

  test("a stray listen address in --url must be https", async () => {
    expect((await fails(run(fake().sys, fakeHub().hub, { url: "http://192.168.1.111:8443" })))?.message).toContain("https");
  });
});
