import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../server/src/config/parse";
import { ensureNodeCert } from "../../server/src/tls";
import { ExitError } from "../src/creds";
import type { HubClient } from "../src/hub";
import { UNIT, nodeSetup, realSys } from "../src/nodesetup";
import type { Sys } from "../src/nodesetup";
import { defined } from "./support";

const CONFIG = "/etc/claude-rc-launcher/config.toml";
const UNIT_PATH = "/etc/systemd/system/claude-rc-launcher.service";
const BIN = "/usr/local/bin/claude-rc-launcher";
const CERT = "/var/lib/claude-rc-launcher/node-cert.pem";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const enrollment = { hub_keys: [{ public_key: KEY }] };
const ASSET = "claude-rc-launcher-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const BINARY = new TextEncoder().encode("#!fake-binary");
const sha = (uint8Array: Uint8Array) => createHash("sha256").update(uint8Array).digest("hex");
const parse = (toml: string) => parseConfig(Bun.TOML.parse(toml), { readFile: () => "x" });

let certPem = "";
let fingerprint = "";
beforeAll(async () => {
  const nodeCert = await ensureNodeCert({
    dir: mkdtempSync(path.join(os.tmpdir(), "rc-setup-")),
    names: ["192.168.1.111"],
  });
  certPem = nodeCert.certPem;
  fingerprint = `sha256:${createHash("sha256").update(new X509Certificate(nodeCert.certPem).raw).digest("hex")}`;
});

interface World {
  calls: string[];
  written: Map<string, string | Uint8Array>;
  fetched: string[];
  started: boolean;
}

function fake(
  options: {
    existing?: string[];
    active?: boolean;
    users?: string[];
    platform?: string;
    arch?: string;
    addresses?: string[];
    sums?: string;
    healthy?: boolean;
    root?: boolean;
    files?: Record<string, string>;
  } = {},
) {
  const world: World = { calls: [], written: new Map(), fetched: [], started: false };
  const existing = new Set(options.existing ?? []);
  let clock = 0;
  const sys: Sys = {
    platform: options.platform ?? "linux",
    arch: options.arch ?? "x64",
    isRoot: () => options.root ?? false,
    hasCommand: (name) => name !== "missing-cmd",
    localAddresses: () => options.addresses ?? ["127.0.0.1", "192.168.1.111"],
    exists: (file) => existing.has(file),
    run(args) {
      world.calls.push(`run ${args.join(" ")}`);
      if (args[0] === "systemctl" && args[1] === "is-active")
        return { code: options.active ? 0 : 3, stdout: options.active ? "active" : "inactive" };
      if (args[0] === "id") return { code: (options.users ?? ["kir"]).includes(args[2]) ? 0 : 1, stdout: "" };
      return { code: 0, stdout: "" };
    },
    sudo(args, input) {
      world.calls.push(`sudo ${args.join(" ")}`);
      if (args[0] === "tee") world.written.set(args[1], input ?? "");
      if (args[0] === "systemctl" && args[1] === "enable") world.started = true;
      if (args[0] === "cat" && args[1] === CERT)
        return world.started
          ? { code: 0, stdout: certPem, stderr: "" }
          : { code: 1, stdout: "", stderr: "no such file" };
      if (args[0] === "journalctl")
        return { code: 0, stdout: "Nov 07 node[1]: startup failed: port in use", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (file) => new TextEncoder().encode(options.files?.[file] ?? ""),
    writeTemp(name, data) {
      const entry = `/tmp/fake/${name}`;
      world.written.set(entry, data);
      return entry;
    },
    removeTemp: (file) => void world.calls.push(`rm ${file}`),
    fetch: ((url: string | URL) => {
      const text = String(url);
      world.fetched.push(text);
      if (text === `${RELEASE}/latest/download/${ASSET}` || text === `${RELEASE}/download/v0.1.0/${ASSET}`)
        return Promise.resolve(new Response(BINARY));
      if (text.endsWith("/SHA256SUMS"))
        return Promise.resolve(
          new Response(options.sums ?? `${sha(BINARY)}  ${ASSET}\n${"0".repeat(64)}  claude-rc-linux-x64\n`),
        );

      if (/^https:\/\/[^/]+\/healthz$/.test(text)) {
        if (!world.started || options.healthy === false) return Promise.reject(new Error("ECONNREFUSED"));
        return Promise.resolve(Response.json({ ok: true }));
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch,
    sleep: (ms) => Promise.resolve(void (clock += ms)),
    now: () => clock,
  };
  return { sys, world: world };
}

function fakeHub(fail?: string, enroll: unknown = enrollment) {
  const requests: { method: string; path: string; body?: any }[] = [];
  const hub = {
    request: (method: string, item: string, body?: unknown) => {
      requests.push({ method, path: item, body });
      if (item === "/cli/api/node-enrollment") return Promise.resolve(enroll);
      if (fail) return Promise.reject(new ExitError(fail, 1));
      return Promise.resolve({ id: "kirhub", source: "managed" });
    },
  } as unknown as HubClient;
  return { hub, requests };
}

const base = { hubUrl: "https://rc.example.com", flags: { listen: "192.168.1.111", name: "kirhub" } as any };

async function run(sys: Sys, hub: HubClient, flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  await nodeSetup({ ...base, flags: { ...base.flags, ...flags }, hub, out: (line) => out.push(line), sys });
  return out;
}

const fails = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (entry) => entry,
  )) as ExitError | undefined;

describe("nodeSetup", () => {
  test("the happy path installs, starts and registers, in order", async () => {
    const { sys, world: world } = fake();
    const { hub, requests } = fakeHub();
    const out = await run(sys, hub, { roots: "/home/kir/p", "service-user": "kir" });
    const order = [
      "install -m 755 /tmp/fake/",
      "mv -f",
      "mkdir -p /etc/claude-rc-launcher",
      `tee ${CONFIG}`,
      `tee ${UNIT_PATH}`,
      "systemctl daemon-reload",
      "systemctl enable --now claude-rc-launcher",
    ];
    const sudoCalls = world.calls.filter((call) => call.startsWith("sudo ")).map((call) => call.slice(5));
    let at = -1;

    for (const step of order) {
      const position = sudoCalls.findIndex((sudoCall, idx) => idx > at && sudoCall.startsWith(step));
      expect([step, position > at]).toEqual([step, true]);
      at = position;
    }

    // The enrollment is fetched before any privileged call, and registration comes last.
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /cli/api/node-enrollment",
      "POST /cli/api/hosts",
    ]);
    expect(world.calls.findIndex((call) => call.startsWith("sudo "))).toBeGreaterThanOrEqual(0);
    expect(requests[1].body).toEqual({ id: "kirhub", name: "kirhub", url: "https://192.168.1.111:8443", fingerprint });
    expect(out.join("\n")).toContain(fingerprint);
    expect(out.join("\n")).toContain("claude-rc host remove kirhub");
  });

  test("the written config is a valid node config with the hub's values and the service user", async () => {
    const { sys, world: world } = fake();
    await run(sys, fakeHub().hub, { roots: "/home/kir/p", "service-user": "kir", names: "kirhub" });
    const cfg = parse(String(world.written.get(CONFIG)));
    expect(cfg).toMatchObject({
      mode: "node",
      name: "kirhub",
      port: 8443,
      host: "192.168.1.111",
      serviceUser: "kir",
      roots: ["/home/kir/p"],
    });
    expect(defined(cfg.node).tls.names).toEqual(["kirhub", "192.168.1.111"]);
    expect(defined(cfg.node).auth.hubKeys).toEqual([KEY]);
  });

  describe("the certificate covers the host in --url", () => {
    const namesOf = async (flags: Record<string, unknown>, addresses?: string[]) => {
      const { sys, world: world } = fake(addresses ? { addresses } : {});
      await run(sys, fakeHub().hub, flags);
      return defined(parse(String(world.written.get(CONFIG))).node).tls.names;
    };

    test("a DNS name in --url is added next to the listen address and --names", async () => {
      expect(await namesOf({ url: "https://node.lan:8443" })).toEqual(["192.168.1.111", "node.lan"]);
      expect(await namesOf({ url: "https://node.lan:8443", names: "kirhub" })).toEqual([
        "kirhub",
        "192.168.1.111",
        "node.lan",
      ]);
    });
    test("a wildcard listen needs no --names when --url names the host", async () => {
      expect(await namesOf({ listen: "0.0.0.0", url: "https://node.lan:8443" }, ["0.0.0.0"])).toEqual(["node.lan"]);
    });
    test("a wildcard listen with other --names still gets the --url host", async () => {
      expect(
        await namesOf({ listen: "0.0.0.0", url: "https://node.lan:8443", names: "10.0.0.5" }, ["0.0.0.0"]),
      ).toEqual(["10.0.0.5", "node.lan"]);
    });
    test("a host that is already listed is not added twice, whatever its case", async () => {
      expect(await namesOf({ url: "https://Node.LAN:8443", names: "node.lan" })).toEqual(["node.lan", "192.168.1.111"]);
      expect(await namesOf({ url: "https://192.168.1.111:8443" })).toEqual(["192.168.1.111"]);
    });
    test("an IPv6 address in --url is added without its brackets", async () => {
      expect(await namesOf({ url: "https://[fd00::1]:8443" })).toEqual(["192.168.1.111", "fd00::1"]);
    });
    test("an invalid --url still gives the --url error", async () => {
      expect((await fails(run(fake().sys, fakeHub().hub, { url: "not a url" })))?.message).toContain(
        "--url is not a valid URL",
      );
    });
  });

  test("the unit is the shipped unit", async () => {
    expect(UNIT).toBe(readFileSync(path.join(import.meta.dir, "../../deploy/claude-rc-launcher.service"), "utf8"));
    const { sys, world: world } = fake();
    await run(sys, fakeHub().hub);
    expect(world.written.get(UNIT_PATH)).toBe(UNIT);
  });

  test("the binary is downloaded from the release, checked against SHA256SUMS and installed under a temporary name", async () => {
    const { sys, world: world } = fake({ arch: "arm64", sums: `${sha(BINARY)}  claude-rc-launcher-linux-arm64\n` });
    const s2 = {
      ...sys,
      fetch: ((item: string) =>
        Promise.resolve(
          String(item).endsWith("linux-arm64") ? new Response(BINARY) : (sys.fetch as any)(item),
        )) as unknown as typeof fetch,
    };
    await run(s2, fakeHub().hub);
    expect(world.calls).toContain(`sudo install -m 755 /tmp/fake/claude-rc-launcher ${BIN}.new`);
    expect(world.calls).toContain(`sudo mv -f ${BIN}.new ${BIN}`);
    expect(world.calls.some((call) => call.startsWith("rm /tmp/fake/"))).toBe(true);
  });

  test("--release picks that release", async () => {
    const { sys, world: world } = fake();
    await run(sys, fakeHub().hub, { release: "v0.1.0" });
    expect(world.fetched).toContain(`${RELEASE}/download/v0.1.0/${ASSET}`);
  });

  test("a checksum mismatch stops before any change", async () => {
    const { sys, world: world } = fake({ sums: `${"1".repeat(64)}  ${ASSET}\n` });
    const exitError = await fails(run(sys, fakeHub().hub));
    expect(exitError?.message).toContain("checksum");
    expect(world.calls.filter((call) => call.startsWith("sudo "))).toEqual([]);
  });

  test("--binary installs that file and downloads nothing", async () => {
    const { sys, world: world } = fake({ files: { "/opt/build/claude-rc-launcher": "local-binary" } });
    await run(sys, fakeHub().hub, { binary: "/opt/build/claude-rc-launcher" });
    expect(world.fetched.filter((item) => item.includes("github.com"))).toEqual([]);
    expect(new TextDecoder().decode(world.written.get("/tmp/fake/claude-rc-launcher") as Uint8Array)).toBe(
      "local-binary",
    );
  });

  test("existing files or a running service are refused without --force, before any request", async () => {
    for (const item of [{ existing: [CONFIG] }, { existing: [UNIT_PATH] }, { active: true }]) {
      const { sys, world: world } = fake(item);
      const { hub, requests } = fakeHub();
      const exitError = await fails(run(sys, hub));
      expect(exitError?.message).toContain("--force");
      expect(requests).toHaveLength(0);
      expect(world.calls.filter((call) => call.startsWith("sudo "))).toEqual([]);
    }
  });

  test("--force keeps the old config and unit as .bak", async () => {
    const { sys, world: world } = fake({ existing: [CONFIG, UNIT_PATH], active: true });
    await run(sys, fakeHub().hub, { force: true });
    expect(world.calls).toContain(`sudo cp -p ${CONFIG} ${CONFIG}.bak`);
    expect(world.calls).toContain(`sudo cp -p ${UNIT_PATH} ${UNIT_PATH}.bak`);
  });

  test("checks that fail before any request: not linux, no systemctl, unsupported arch, foreign address, wildcard, unknown user", async () => {
    const cases: [string, Parameters<typeof fake>[0], Record<string, unknown>, string][] = [
      ["not linux", { platform: "darwin" }, {}, "Linux"],
      ["unsupported arch", { arch: "ia32" }, {}, "architecture"],
      ["foreign address", { addresses: ["10.0.0.5"] }, {}, "192.168.1.111"],
      ["wildcard without --url", { addresses: ["0.0.0.0"] }, { listen: "0.0.0.0" }, "--url"],
      ["unknown user", {}, { "service-user": "nobody-here" }, "nobody-here"],
    ];

    for (const [name, item, flags, text] of cases) {
      const { sys, world: world } = fake(item);
      const { hub, requests } = fakeHub();
      const exitError = await fails(run(sys, hub, flags));
      expect([name, exitError?.message.includes(text)]).toEqual([name, true]);
      expect(requests).toHaveLength(0);
      expect(world.calls.filter((call) => call.startsWith("sudo "))).toEqual([]);
    }

    const noSystemctl = fake();
    noSystemctl.sys.hasCommand = () => false;
    expect((await fails(run(noSystemctl.sys, fakeHub().hub)))?.message).toContain("systemctl");
  });

  test("an old hub (oidc, no hub_keys) or an empty hub_keys is refused before anything is written", async () => {
    for (const [name, enroll] of [
      ["old hub", { oidc: { issuer: "https://idp.example.com" } }],
      ["empty hub_keys", { hub_keys: [] }],
    ] as const) {
      const { sys, world: world } = fake();
      const { hub, requests } = fakeHub(undefined, enroll);
      const exitError = await fails(run(sys, hub));
      expect([name, exitError?.message]).toEqual([
        name,
        "the hub did not return a hub key. Upgrade the hub to a version that supports hub keys.",
      ]);
      expect(exitError?.code).toBe(1);
      expect(requests.map((request) => request.path)).toEqual(["/cli/api/node-enrollment"]);
      expect(world.calls.filter((call) => call.startsWith("sudo "))).toEqual([]);
      expect(world.written.size).toBe(0);
      expect(world.fetched).toEqual([]);
    }
  });

  test("a node that never becomes healthy prints the journal and does not register", async () => {
    const { sys } = fake({ healthy: false });
    const { hub, requests } = fakeHub();
    const exitError = await fails(run(sys, hub));
    expect(exitError?.message).toContain("did not become healthy");
    expect(exitError?.message).toContain("startup failed: port in use");
    expect(requests.map((request) => request.path)).toEqual(["/cli/api/node-enrollment"]);
  });

  test("a registration failure leaves the node running and prints the retry command", async () => {
    const { sys, world: world } = fake();
    const exitError = await fails(run(sys, fakeHub("host kirhub: rejected our credentials").hub));
    expect(exitError?.message).toContain("rejected our credentials");
    expect(exitError?.message).toContain(
      "claude-rc host add kirhub --url https://192.168.1.111:8443 --fingerprint " + fingerprint,
    );
    expect(world.calls.some((call) => call.includes("systemctl stop") || call.includes("systemctl disable"))).toBe(
      false,
    );
  });

  test("the host id comes from --id, else from --name, and a bad one is refused", async () => {
    const hub = fakeHub();
    await run(fake().sys, hub.hub, { id: "pi-1", name: "Pi One" });
    expect(hub.requests[1].body).toMatchObject({ id: "pi-1", name: "Pi One" });
    const harness = fakeHub();
    await run(fake().sys, harness.hub, { name: "Kir Hub!" });
    expect(harness.requests[1].body.id).toBe("kir-hub");
    expect((await fails(run(fake().sys, fakeHub().hub, { id: "Bad_Id" })))?.message).toContain("--id");
  });

  test("the real sys runs privileged commands directly as root, and passes input and output through", () => {
    if (process.getuid?.() !== 0) return;
    const result = realSys.sudo(["cat"], "from stdin");
    expect(result).toMatchObject({ code: 0, stdout: "from stdin" });
    expect(realSys.sudo(["false"]).code).not.toBe(0);
  });

  test("a missing claude for the service user is a warning, not an error", async () => {
    const { sys } = fake();
    const out = await run(sys, fakeHub().hub, { "service-user": "kir" });
    expect(out.join("\n")).toMatch(/warning: .*claude/);
  });

  test("a stray listen address in --url must be https", async () => {
    expect((await fails(run(fake().sys, fakeHub().hub, { url: "http://192.168.1.111:8443" })))?.message).toContain(
      "https",
    );
  });
});
