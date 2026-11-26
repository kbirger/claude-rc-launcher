import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExitError, saveCreds } from "../src/creds";
import type { Credentials } from "../src/creds";
import { HubError } from "../src/hub";
import type { HubClient } from "../src/hub";
import { main } from "../src/index";
import type { Env } from "../src/index";
import { parseCli } from "../src/args";
import type { Flags } from "../src/args";
import { sshTargetUpdate, SSH_TARGET_UPDATE_USAGE } from "../src/sshtarget";
import { rejection } from "./support";

const LINE = 'from="10.0.0.1,10.0.0.2",restrict ssh-ed25519 AAAAC3Nza claude-rc:nas';

function rig(reply: unknown) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const out: string[] = [];
  const hub = {
    request: (method: string, requestPath: string, body?: unknown) => {
      calls.push({ method, path: requestPath, body });
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } as unknown as HubClient;
  const run = (flags: Flags, id = "nas") => sshTargetUpdate({ id, flags, hub, out: (line) => out.push(line) });
  return { calls, out, run };
}

const exitCode = (error: Error) => (error instanceof ExitError ? error.code : undefined);

describe("sshTargetUpdate", () => {
  test("it sends the list in the order given and prints it", async () => {
    const { calls, out, run } = rig({ id: "nas", nodes: ["pi", "vm"], managedHost: "nas", lineUpdated: true });
    await run({ node: "pi,vm" });
    expect(calls).toEqual([{ method: "PATCH", path: "/cli/api/ssh/targets/nas", body: { nodes: ["pi", "vm"] } }]);
    expect(out).toEqual(["target nas nodes: pi, vm", "the key line on the machine was updated"]);
  });

  test("an external target prints the new key line to install", async () => {
    const { out, run } = rig({ id: "nas", nodes: ["pi"], installLine: LINE });
    await run({ node: "pi" });
    expect(out[0]).toBe("target nas nodes: pi");
    expect(out.at(-1)).toBe(LINE);
    expect(out.join("\n")).toContain("replace the old line");
  });

  test("it says so when a node could not be told, and when a managed target has no key yet", async () => {
    const { out, run } = rig({ id: "nas", nodes: ["pi"], managedHost: "nas", pushed: false });
    await run({ node: "pi" });
    expect(out.join("\n")).toContain("some nodes could not be told");
    expect(out.at(-1)).toBe("the target has no key yet, so it has no key line on the machine");
    expect(out.join("\n")).not.toContain("did not need");
  });

  test("a bad call exits 1 with the usage and calls no route", async () => {
    const bad: [Flags, string?][] = [
      [{}],
      [{ node: "" }],
      [{ node: "a,,b" }],
      [{ node: "a,a" }],
      [{ node: "../x" }],
      [{ node: "a" }, "../x"],
    ];

    for (const [flags, id] of bad) {
      const { calls, run } = rig({});
      const error = await rejection(run(flags, id));
      expect([error.message.startsWith(SSH_TARGET_UPDATE_USAGE), exitCode(error)]).toEqual([true, 1]);
      expect(calls).toEqual([]);
    }
  });

  test("a refusal of the hub exits 1 with its text", async () => {
    const { run } = rig(new HubError("the key line on the machine was not updated", 502, undefined));
    const error = await rejection(run({ node: "pi" }));
    expect(error.message).toBe("updating the target failed: the key line on the machine was not updated");
    expect(exitCode(error)).toBe(1);
  });

  test("--node is parsed by the command line parser", () => {
    expect(parseCli(["ssh", "target", "update", "nas", "--node", "a,b"])).toEqual({
      command: ["ssh", "target", "update", "nas"],
      flags: { node: "a,b" },
    });
  });
});

describe("claude-rc ssh target update through main", () => {
  const stops: (() => void)[] = [];
  afterAll(() => {
    stops.forEach((stop) => {
      stop();
    });
  });

  function harness() {
    const seen: { method: string; path: string; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ method: req.method, path: new URL(req.url).pathname, body: await req.text() });
        return Response.json({ id: "nas", nodes: ["pi"], installLine: LINE });
      },
    });
    stops.push(() => server.stop(true));
    const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-upd-")), "credentials.json");
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
    const run = (...argv: string[]) => main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env);
    return { seen, out, err, run };
  }

  test("it patches the target and prints the line", async () => {
    const { seen, out, run } = harness();
    expect(await run("ssh", "target", "update", "nas", "--node", "pi")).toBe(0);
    expect(seen).toEqual([{ method: "PATCH", path: "/cli/api/ssh/targets/nas", body: '{"nodes":["pi"]}' }]);
    expect(out.at(-1)).toBe(LINE);
  });

  test("a missing id, a missing --node and an extra word give the usage and call no route", async () => {
    for (const argv of [
      ["ssh", "target", "update"],
      ["ssh", "target", "update", "nas"],
      ["ssh", "target", "update", "nas", "extra", "--node", "pi"],
    ]) {
      const { seen, err, run } = harness();
      expect(await run(...argv)).toBe(1);
      expect(err.join("\n").startsWith(SSH_TARGET_UPDATE_USAGE)).toBe(true);
      expect(seen).toEqual([]);
    }
  });

  test("another word before update does not run the update and calls no route", async () => {
    for (const argv of [
      ["ssh", "anything", "update", "nas", "--node", "pi"],
      ["ssh", "update", "nas", "--node", "pi"],
    ]) {
      const { seen, err, run } = harness();
      expect(await run(...argv)).toBe(1);
      expect(err.join("\n")).toContain("usage:");
      expect(seen).toEqual([]);
    }
  });

  test("an unknown ssh target word lists both usages", async () => {
    const { err, run } = harness();
    expect(await run("ssh", "target", "remove", "nas")).toBe(1);
    expect(err.join("\n")).toContain("ssh target add <id>");
    expect(err.join("\n")).toContain(SSH_TARGET_UPDATE_USAGE);
  });
});
