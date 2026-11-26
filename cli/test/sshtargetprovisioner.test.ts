import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCli } from "../src/args";
import { saveCreds } from "../src/creds";
import { main, USAGE } from "../src/index";
import type { Env } from "../src/index";
import { ExitError } from "../src/creds";
import type { Flags } from "../src/args";
import { HubError } from "../src/hub";
import type { HubClient } from "../src/hub";
import { approveMaintenance } from "../src/sshmaintenance";
import { sshTargetAdd, sshTargetProvisioner, SSH_TARGET_USAGE, SSH_TARGET_PROVISIONER_USAGE } from "../src/sshtarget";
import { rejection } from "./support";

const HUB = "https://hub.example";
const FP = "SHA256:abcDEF123";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest";
const IDENTITY = "/home/owner/.ssh/secret-identity-file";
const SCRIPT_PATH = "/home/backup/.claude-rc/provisioner-nas.sh";
const B = "/cli/api/ssh";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (body: unknown) => unknown;

const exitCode = (error: Error): number | undefined => (error instanceof ExitError ? error.code : undefined);

const grant = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  targetId: "nas",
  state: "pending",
  maintenance: { action: "install", fromNodes: ["pi"], fromSources: ["10.0.0.1"] },
  ...over,
});
const done = (action = "install") =>
  grant({
    state: "ended",
    endReason: "done",
    maintenance: { action, fromNodes: ["pi"], fromSources: ["10.0.0.1"], result: "done" },
  });

function rig(
  routes: Record<string, Handler> = {},
  options: { method?: "prf" | "passphrase"; installStdout?: string; installCode?: number } = {},
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const secrets: string[] = [];
  const ssh: { argv: string[]; stdin: string }[] = [];
  const method = options.method ?? "passphrase";
  const base: Record<string, Handler> = {
    [`GET ${B}/status`]: () => ({ setUp: true, method, nodes: [] }),
    [`POST ${B}/targets`]: () => ({ id: "nas", state: "draft" }),
    [`POST ${B}/targets/nas/key`]: () => ({ publicLine: "x", fingerprint: FP, installLine: "y" }),
    [`POST ${B}/targets/nas/scan`]: () => ({ keys: [{ line: HOST_KEY, fingerprint: FP }] }),
    [`POST ${B}/targets/nas/pin`]: () => ({}),
    [`GET ${B}/targets/nas`]: () => ({
      id: "nas",
      state: "draft",
      hostKey: HOST_KEY,
      keyFingerprint: FP,
      address: "nas.lan",
      account: "backup",
      port: 22,
      systemType: "linux",
    }),
    [`GET ${B}/targets/nas/provision`]: () => ({ shell: "sh", script: "echo main\n" }),
    [`POST ${B}/targets/nas/test`]: () => ({ ok: true }),
    [`POST ${B}/targets/nas/provisioner-key`]: () => ({ publicLine: "p", fingerprint: "SHA256:prov" }),
    [`GET ${B}/targets/nas/provisioner-install`]: () => ({ shell: "sh", script: "echo prov\n" }),
    [`POST ${B}/targets/nas/provisioner-installed`]: () => ({ id: "nas" }),
    [`POST ${B}/targets/nas/reinstall`]: () => ({ maintenance: grant() }),
    [`POST ${B}/grants/g1/approve`]: () => done(),
    [`GET ${B}/grants`]: () => [done()],
    ...routes,
  };
  const hub = {
    request: (m: string, path: string, body?: unknown) => {
      calls.push({ method: m, path, body });
      const handler = base[`${m} ${path}`];
      if (!handler) return Promise.reject(new HubError("no route", 404, undefined));
      try {
        return Promise.resolve(handler(body));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as HubClient;
  const common = {
    hub,
    hubUrl: HUB,
    readLine: () => Promise.resolve("y"),
    readSecret: () => {
      secrets.push("asked");
      return Promise.resolve(`secret-${secrets.length}`);
    },
    runLocal: (argv: string[], stdin: string) => {
      ssh.push({ argv, stdin });
      const prov = stdin.includes("echo prov");
      return Promise.resolve({
        code: prov ? (options.installCode ?? 0) : 0,
        stderr: "",
        stdout: prov ? (options.installStdout ?? `ok installed ${SCRIPT_PATH}\n`) : "",
      });
    },
    out: (line: string) => out.push(line),
    sleep: () => Promise.resolve(),
  };
  return {
    calls,
    out,
    secrets,
    ssh,
    paths: () => calls.map((c) => `${c.method} ${c.path.replace(B, "")}`),
    add: (flags: Flags) => sshTargetAdd({ id: "nas", flags, ...common }),
    prov: (flags: Flags) => sshTargetProvisioner({ id: "nas", flags, ...common }),
    approve: (g = grant()) => approveMaintenance(g, { ...common, method }),
  };
}

const external: Flags = {
  type: "linux",
  address: "nas.lan",
  account: "backup",
  node: "pi",
  identity: IDENTITY,
  fingerprint: FP,
  provisioner: true,
};

describe("add --provisioner", () => {
  test("it refuses windows and --managed before any call", async () => {
    for (const flags of [
      { ...external, type: "windows" },
      { type: "linux", account: "backup", node: "pi", managed: "nas-host", provisioner: true },
    ]) {
      const rg = rig();
      const error = await rejection(rg.add(flags));
      expect(exitCode(error)).toBe(1);
      expect(error.message).toStartWith(SSH_TARGET_USAGE);
      expect(error.message).toContain("--provisioner");
      expect(rg.calls).toEqual([]);
    }
  });

  test("it makes the key, runs the install with the pinned host key and reports the path", async () => {
    const rg = rig();
    await rg.add(external);
    expect(rg.ssh).toHaveLength(2);
    const second = rg.ssh[1];
    expect(second?.stdin).toBe("echo prov\n");
    const argv = second?.argv ?? [];
    expect(argv[argv.indexOf("-i") + 1]).toBe(IDENTITY);
    expect(argv).toContain("StrictHostKeyChecking=yes");
    const installed = rg.calls.find((c) => c.path.endsWith("/provisioner-installed"));
    expect(installed?.body).toEqual({ script: SCRIPT_PATH });
    const made = rg.calls.find((c) => c.path.endsWith("/provisioner-key"));
    expect((made?.body as { unlock: { method: string } }).unlock.method).toBe("passphrase");
    expect(rg.out.join("\n")).toContain(SCRIPT_PATH);
  });

  test("it ends with a maintenance install and prints its result", async () => {
    const rg = rig();
    await rg.add(external);
    const paths = rg.paths();
    expect(paths.indexOf("POST /targets/nas/test")).toBeLessThan(paths.indexOf("POST /targets/nas/reinstall"));
    expect(paths.at(-1)).toBe("POST /grants/g1/approve");
    expect(rg.secrets).toHaveLength(4);
    expect(rg.out.at(-1)).toContain("provisioner works");
  });

  test("--no-test skips the maintenance install too", async () => {
    const rg = rig();
    await rg.add({ ...external, "no-test": true });
    expect(rg.paths()).not.toContain("POST /targets/nas/reinstall");
    expect(rg.paths()).not.toContain("POST /targets/nas/test");
    expect(rg.paths()).toContain("POST /targets/nas/provisioner-installed");
  });

  test("the identity path never reaches the hub", async () => {
    const rg = rig();
    await rg.add(external);
    expect(JSON.stringify(rg.calls)).not.toContain(IDENTITY);
    expect(JSON.stringify(rg.calls)).not.toContain("secret-identity-file");
  });

  test("a script that gives no valid answer stops the add and stores nothing", async () => {
    const rg = rig({}, { installStdout: "hello\n" });
    const error = await rejection(rg.add(external));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("no valid answer");
    expect(rg.paths()).not.toContain("POST /targets/nas/provisioner-installed");
  });

  test("a failed ssh stops the add and hides the identity path", async () => {
    const rg = rig({}, { installCode: 255 });
    const error = await rejection(rg.add(external));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("installing the provisioner failed");
  });

  test("a failed maintenance install exits 1 and names the repair command", async () => {
    const rg = rig({
      [`POST ${B}/grants/g1/approve`]: () => {
        throw new HubError("the key line was not put back on the machine: ssh exited with 255", 502, undefined);
      },
    });
    const error = await rejection(rg.add(external));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("ssh exited with 255");
    expect(error.message).toContain("claude-rc ssh target provisioner nas --identity");
  });

  test("with a passkey it prints the links and waits for the key and for the end of the grant", async () => {
    let tries = 0;
    const rg = rig(
      {
        [`GET ${B}/targets/nas`]: () => ({
          id: "nas",
          state: "ready",
          hostKey: HOST_KEY,
          keyFingerprint: FP,
          address: "nas.lan",
          account: "backup",
          port: 22,
          systemType: "linux",
        }),
        [`GET ${B}/targets/nas/provisioner-install`]: () => {
          tries += 1;
          if (tries < 3) throw new HubError("the target has no provisioner key", 409, undefined);
          return { shell: "sh", script: "echo prov\n" };
        },
      },
      { method: "prf" },
    );
    await rg.add(external);
    const text = rg.out.join("\n");
    expect(text).toContain("provisioner=1");
    expect(text).toContain("approve");
    expect(rg.paths()).not.toContain("POST /targets/nas/provisioner-key");
    expect(rg.secrets).toEqual([]);
    expect(rg.paths().at(-1)).toBe("GET /grants");
  });
});

describe("target provisioner", () => {
  test("it needs --identity and refuses extra flags", async () => {
    const rg = rig();
    const error = await rejection(rg.prov({}));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toStartWith(SSH_TARGET_PROVISIONER_USAGE);
    expect(rg.calls).toEqual([]);
  });

  test("it needs a pinned host key", async () => {
    const rg = rig({
      [`GET ${B}/targets/nas`]: () => ({ id: "nas", state: "draft", address: "nas.lan", account: "backup", port: 22 }),
    });
    const error = await rejection(rg.prov({ identity: IDENTITY }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("pinned host key");
    expect(rg.ssh).toEqual([]);
  });

  test("it refuses a managed target and a windows target", async () => {
    for (const extra of [{ managedHost: "h" }, { systemType: "windows" }]) {
      const rg = rig({
        [`GET ${B}/targets/nas`]: () => ({
          id: "nas",
          hostKey: HOST_KEY,
          address: "nas.lan",
          account: "backup",
          port: 22,
          systemType: "linux",
          ...extra,
        }),
      });
      const error = await rejection(rg.prov({ identity: IDENTITY }));
      expect(exitCode(error)).toBe(1);
      expect(rg.ssh).toEqual([]);
    }
  });

  test("it replaces a key that exists, installs, stores the path and proves the chain", async () => {
    let posts = 0;
    const rg = rig({
      [`POST ${B}/targets/nas/provisioner-key`]: () => {
        posts += 1;
        if (posts === 1) throw new HubError("the target has a provisioner key already", 409, undefined);
        return { publicLine: "p", fingerprint: "SHA256:prov" };
      },
      [`DELETE ${B}/targets/nas/provisioner-key`]: () => undefined,
    });
    await rg.prov({ identity: IDENTITY });
    expect(rg.paths().filter((p) => p.includes("provisioner-key"))).toEqual([
      "POST /targets/nas/provisioner-key",
      "DELETE /targets/nas/provisioner-key",
      "POST /targets/nas/provisioner-key",
    ]);
    expect(rg.ssh).toHaveLength(1);
    expect(rg.paths().slice(-3)).toEqual([
      "POST /targets/nas/provisioner-installed",
      "POST /targets/nas/reinstall",
      "POST /grants/g1/approve",
    ]);
    expect(JSON.stringify(rg.calls)).not.toContain(IDENTITY);
  });

  test("a --fingerprint that does not match the pinned key stops it", async () => {
    const rg = rig();
    const error = await rejection(rg.prov({ identity: IDENTITY, fingerprint: "SHA256:other" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("--fingerprint");
    expect(rg.ssh).toEqual([]);
  });
});

describe("approveMaintenance", () => {
  test("a passphrase approve posts the unlock and returns the grant", async () => {
    const rg = rig();
    const result = await rg.approve();
    expect(result.maintenance?.result).toBe("done");
    const post = rg.calls.find((c) => c.path.endsWith("/approve"));
    expect((post?.body as { unlock: { method: string; secret: string } }).unlock).toEqual({
      method: "passphrase",
      secret: Buffer.from("secret-1").toString("base64url"),
    });
  });

  test("a wrong passphrase says that the request still waits", async () => {
    const rg = rig({
      [`POST ${B}/grants/g1/approve`]: () => {
        throw new HubError("the unlock does not open the key", 403, undefined);
      },
    });
    const error = await rejection(rg.approve());
    expect(error.message).toContain("the unlock does not open the key");
    expect(error.message).toContain("still waits");
  });

  test("a grant that ends without a result is reported", async () => {
    const rg = rig({ [`GET ${B}/grants`]: () => [grant({ state: "ended", endReason: "denied" })] }, { method: "prf" });
    const error = await rejection(rg.approve());
    expect(error.message).toContain("denied");
  });

  test("a grant that is gone from the list is reported", async () => {
    const rg = rig({ [`GET ${B}/grants`]: () => [] }, { method: "prf" });
    const error = await rejection(rg.approve());
    expect(error.message).toContain("is gone");
  });

  test("a failed result is reported with its text", async () => {
    const failed = grant({
      state: "ended",
      endReason: "done",
      maintenance: {
        action: "install",
        fromNodes: [],
        fromSources: [],
        result: "failed",
        detail: "ssh exited with 255",
      },
    });
    const rg = rig({ [`GET ${B}/grants`]: () => [failed] }, { method: "prf" });
    const error = await rejection(rg.approve());
    expect(error.message).toContain("ssh exited with 255");
  });

  test("polling stops after 10 minutes and says what to do", async () => {
    let slept = 0;
    const rg = rig({ [`GET ${B}/grants`]: () => [grant({ state: "active" })] }, { method: "prf" });
    const hub = { request: () => Promise.resolve([grant({ state: "active" })]) } as unknown as HubClient;
    const error = await rejection(
      approveMaintenance(grant(), {
        hub,
        hubUrl: HUB,
        method: "prf",
        readSecret: () => Promise.resolve(""),
        out: () => {},
        sleep: () => {
          slept += 1;
          return Promise.resolve();
        },
      }),
    );
    expect(slept).toBeGreaterThan(100);
    expect(error.message).toContain("10 minutes");
    expect(error.message).toContain("web page");
    expect(rg.calls).toEqual([]);
  });

  test("an uninstall answer is read through retired", async () => {
    const answer = {
      ...done("uninstall"),
      retired: { id: "nas", line: "removed" },
    };
    const rg = rig({ [`POST ${B}/grants/g1/approve`]: () => answer });
    const result = await rg.approve(grant({ maintenance: { action: "uninstall", fromNodes: [], fromSources: [] } }));
    expect(result.retired?.line).toBe("removed");
    const failedRun = {
      ...grant({
        state: "ended",
        maintenance: { action: "uninstall", fromNodes: [], fromSources: [], result: "failed" },
      }),
      retired: { id: "nas", line: "failed", detail: "the run failed" },
    };
    const rg2 = rig({ [`POST ${B}/grants/g1/approve`]: () => failedRun });
    const second = await rg2.approve(grant({ maintenance: { action: "uninstall", fromNodes: [], fromSources: [] } }));
    expect(second.retired?.line).toBe("failed");
  });
});

describe("the command line", () => {
  test("--provisioner and --yes are parsed", () => {
    expect(parseCli(["ssh", "target", "add", "nas", "--provisioner"]).flags).toEqual({ provisioner: true });
    expect(parseCli(["ssh", "target", "provisioner", "nas", "--identity", "k"]).command).toEqual([
      "ssh",
      "target",
      "provisioner",
      "nas",
    ]);
  });

  test("the usage text names the flags and the command", () => {
    expect(SSH_TARGET_USAGE).toContain("--provisioner");
    expect(SSH_TARGET_PROVISIONER_USAGE).toContain("ssh target provisioner <id> --identity <file>");
    expect(USAGE).toContain("ssh target provisioner <id> --identity <file>");
    expect(USAGE).toContain("--yes: confirm");
  });

  test("main refuses a provisioner call without an id or without --identity and calls no route", async () => {
    for (const argv of [
      ["ssh", "target", "provisioner"],
      ["ssh", "target", "provisioner", "nas"],
      ["ssh", "target", "provisioner", "nas", "extra", "--identity", "k"],
    ]) {
      const seen: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          seen.push(req.url);
          return Response.json({});
        },
      });

      try {
        const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-prov-")), "credentials.json");
        saveCreds(credsFile, {
          hub: `http://127.0.0.1:${server.port}`,
          issuer: "i",
          clientId: "c",
          tokenEndpoint: "t",
          idToken: "tok",
          refreshToken: "r",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
        const errors: string[] = [];
        const code = await main(argv, { out: () => {}, err: (line) => errors.push(line) }, {
          credsFile,
          open: async () => {},
          readLine: () => Promise.resolve(""),
          sleep: async () => {},
        } as Env);
        expect(code).toBe(1);
        expect(errors.join("\n")).toContain("ssh target provisioner <id> --identity <file>");
        expect(seen).toEqual([]);
      } finally {
        server.stop(true);
      }
    }
  });
});
