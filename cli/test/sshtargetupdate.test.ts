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

function rig(reply: unknown, extra: Record<string, () => unknown> = {}, secrets: string[] = []) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const out: string[] = [];
  const hub = {
    request: (method: string, requestPath: string, body?: unknown) => {
      calls.push({ method, path: requestPath, body });
      if (method === "GET" && requestPath.endsWith("/status") && !extra[`GET ${requestPath}`])
        return Promise.resolve({ method: "passphrase" });
      const extraHandler = extra[`${method} ${requestPath}`];
      if (extraHandler) {
        try {
          return Promise.resolve(extraHandler());
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } as unknown as HubClient;
  const run = (flags: Flags, id = "nas") =>
    sshTargetUpdate({
      id,
      flags,
      hub,
      hubUrl: "https://hub.example",
      readSecret: () => {
        secrets.push("asked");
        return Promise.resolve("my passphrase");
      },
      out: (line) => out.push(line),
      sleep: () => Promise.resolve(),
    });
  return { calls, out, run, secrets, hub };
}

const exitCode = (error: Error) => (error instanceof ExitError ? error.code : undefined);

describe("sshTargetUpdate", () => {
  test("it sends the list in the order given and prints it", async () => {
    const { calls, out, run } = rig({ id: "nas", nodes: ["pi", "vm"], managedHost: "nas", lineUpdated: true });
    await run({ node: "pi,vm" });
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/cli/api/ssh/targets/nas", body: { nodes: ["pi", "vm"] } },
    ]);
    expect(out).toEqual(["target nas nodes: pi, vm", "the key line on the machine was updated"]);
  });

  test("an external target prints the new key line to install", async () => {
    const { out, run } = rig({ id: "nas", nodes: ["pi"], installLine: LINE });
    await run({ node: "pi" });
    expect(out[0]).toBe("target nas nodes: pi");
    expect(out.at(-1)).toBe(LINE);
    expect(out.join("\n")).toContain("replace the old line");
  });

  test("an external dropbear target says that its key line stays the same", async () => {
    const { out, run } = rig({ id: "nas", nodes: ["pi"], systemType: "dropbear", keyFingerprint: "SHA256:k" });
    await run({ node: "pi" });
    expect(out).toEqual([
      "target nas nodes: pi",
      "the key line on the router stays the same, because Dropbear does not limit a key by address",
    ]);
  });

  test("an external dropbear target with no key says nothing about a key line", async () => {
    const { out, run } = rig({ id: "nas", nodes: ["pi"], systemType: "dropbear" });
    await run({ node: "pi" });
    expect(out).toEqual(["target nas nodes: pi"]);
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

const GRANT = { id: "g1", targetId: "nas", state: "pending", maintenance: { action: "sources", toNodes: ["pi"] } };
const DONE = {
  ...GRANT,
  state: "ended",
  endReason: "done",
  maintenance: { action: "sources", fromNodes: ["vm"], toNodes: ["pi"], result: "done" },
  target: { id: "nas", nodes: ["pi"] },
  pushed: true,
};
const APPROVE = "POST /cli/api/ssh/grants/g1/approve";
const STATUS = "GET /cli/api/ssh/status";

describe("sshTargetUpdate with a provisioner", () => {
  test("a 202 asks for the passphrase, approves and prints the result", async () => {
    const rg = rig({ maintenance: GRANT }, { [STATUS]: () => ({ method: "passphrase" }), [APPROVE]: () => DONE });
    await rg.run({ node: "pi" });
    const approve = rg.calls.find((call) => `${call.method} ${call.path}` === APPROVE);
    expect(approve?.body).toEqual({
      unlock: { method: "passphrase", secret: Buffer.from("my passphrase").toString("base64url") },
    });
    expect(rg.secrets).toHaveLength(1);
    expect(rg.out.join("\n")).toContain("waits for the approval");
    expect(rg.out).toContain("target nas nodes: pi");
    expect(rg.out.at(-1)).toBe("the key line on the machine was updated");
    expect(JSON.stringify(rg.calls)).not.toContain("my passphrase");
  });

  test("an approved change of a dropbear target says that the key line stays the same", async () => {
    const done = { ...DONE, target: { id: "nas", nodes: ["pi"], systemType: "dropbear" } };
    const rg = rig({ maintenance: GRANT }, { [STATUS]: () => ({ method: "passphrase" }), [APPROVE]: () => done });
    await rg.run({ node: "pi" });
    expect(rg.out.at(-1)).toBe(
      "the key line on the router stays the same, because Dropbear does not limit a key by address",
    );
    expect(rg.out).not.toContain("the key line on the machine was updated");
  });

  test("with a passkey it prints the link and waits for the end of the grant", async () => {
    let polls = 0;
    const rg = rig(
      { maintenance: GRANT },
      {
        [STATUS]: () => ({ method: "prf" }),
        "GET /cli/api/ssh/grants": () => {
          polls += 1;
          return [polls < 3 ? { ...GRANT, state: "active" } : DONE];
        },
      },
    );
    await rg.run({ node: "pi" });
    expect(rg.secrets).toEqual([]);
    expect(rg.out.join("\n")).toContain("https://hub.example/ssh?target=nas");
    expect(polls).toBe(3);
    expect(rg.out).toContain("target nas nodes: pi");
  });

  test("with a passkey, a dropbear change says that the key line stays the same", async () => {
    let polls = 0;
    const rg = rig(
      { maintenance: GRANT },
      {
        [STATUS]: () => ({ method: "prf" }),
        "GET /cli/api/ssh/grants": () => {
          polls += 1;
          return [polls < 2 ? { ...GRANT, state: "active" } : { ...DONE, target: undefined }];
        },
        "GET /cli/api/ssh/targets/nas": () => ({ id: "nas", nodes: ["pi"], systemType: "dropbear" }),
      },
    );
    await rg.run({ node: "pi" });
    expect(rg.out.join("\n")).toContain("https://hub.example/ssh?target=nas and approve");
    expect(rg.out.at(-1)).toBe(
      "the key line on the router stays the same, because Dropbear does not limit a key by address",
    );
  });

  test("the 409 that asks for confirmation exits 1 and names --yes", async () => {
    const text = "the new list allows none of the addresses that work now: send it again with confirm";
    const rg = rig(new HubError(text, 409, undefined));
    const error = await rejection(rg.run({ node: "pi" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("allows none of the addresses that work now");
    expect(error.message).toContain("--yes");
    expect(error.message).not.toContain("send it again with confirm");
  });

  test("--yes sends confirm true", async () => {
    const rg = rig({ maintenance: GRANT }, { [STATUS]: () => ({ method: "passphrase" }), [APPROVE]: () => DONE });
    await rg.run({ node: "pi", yes: true });
    expect(rg.calls.find((call) => call.method === "PATCH")?.body).toEqual({ nodes: ["pi"], confirm: true });
  });

  test("without --yes the body has no confirm", async () => {
    const rg = rig({ id: "nas", nodes: ["pi"] });
    await rg.run({ node: "pi" });
    expect(rg.calls.find((call) => call.method === "PATCH")?.body).toEqual({ nodes: ["pi"] });
  });

  test("a failed run exits 1 and prints the text of the hub", async () => {
    const rg = rig(
      { maintenance: GRANT },
      {
        [STATUS]: () => ({ method: "passphrase" }),
        [APPROVE]: () => {
          throw new HubError(
            "the key line on the machine was not updated, so the node list is as it was: ssh exited with 255",
            502,
            undefined,
          );
        },
      },
    );
    const error = await rejection(rg.run({ node: "pi" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("the node list is as it was");
    expect(error.message).toContain("ssh exited with 255");
  });

  test("a failed run that a passkey approve ended exits 1 with its detail", async () => {
    const failed = {
      ...GRANT,
      state: "ended",
      maintenance: { action: "sources", result: "failed", detail: "the script refused" },
    };
    const rg = rig(
      { maintenance: GRANT },
      { [STATUS]: () => ({ method: "prf" }), "GET /cli/api/ssh/grants": () => [failed] },
    );
    const error = await rejection(rg.run({ node: "pi" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("the script refused");
  });

  test("a denied grant exits 1 and says that nothing changed", async () => {
    const denied = { ...GRANT, state: "ended", endReason: "denied" };
    const rg = rig(
      { maintenance: GRANT },
      { [STATUS]: () => ({ method: "prf" }), "GET /cli/api/ssh/grants": () => [denied] },
    );
    const error = await rejection(rg.run({ node: "pi" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("denied");
    expect(error.message).toContain("Nothing was changed");
  });
});

describe("sshTargetUpdate failures after the 202", () => {
  const STILL = "still waits on the hub: deny it on the web page or wait for it to expire";

  test("the status is read before the change", async () => {
    const rg = rig({ maintenance: GRANT }, { [APPROVE]: () => DONE });
    await rg.run({ node: "pi" });
    expect(rg.calls.map((call) => call.method)[0]).toBe("GET");
    expect(rg.calls[0]?.path).toEndWith("/status");
  });

  test("a failed status read stops before the change", async () => {
    const rg = rig(
      {},
      {
        [STATUS]: () => {
          throw new HubError("down", 500, undefined);
        },
      },
    );
    const error = await rejection(rg.run({ node: "pi" }));
    expect(error.message).toContain("reading the SSH status failed");
    expect(rg.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("an empty passphrase says that the request still waits, and a network error says to check the target", async () => {
    const empty = rig({ maintenance: GRANT }, {});
    const error = await rejection(
      sshTargetUpdate({
        id: "nas",
        flags: { node: "pi" },
        hub: empty.hub,
        hubUrl: "https://h",
        readSecret: () => Promise.resolve(""),
        out: () => {},
      }),
    );
    expect(error.message).toContain("no passphrase");
    expect(error.message).toContain(STILL);
    const down = rig(
      { maintenance: GRANT },
      {
        [APPROVE]: () => {
          throw new ExitError("cannot reach the hub", 1);
        },
      },
    );
    const second = await rejection(down.run({ node: "pi" }));
    expect(second.message).not.toContain(STILL);
    expect(second.message).toContain("Check the target on the web page");
  });

  test("a failed run does not say that the request waits", async () => {
    const rg = rig(
      { maintenance: GRANT },
      {
        [APPROVE]: () => {
          throw new HubError("failed run", 502, undefined);
        },
      },
    );
    const error = await rejection(rg.run({ node: "pi" }));
    expect(error.message).not.toContain(STILL);
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
    const run = (...argv: string[]) =>
      main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env);
    return { seen, out, err, run };
  }

  test("it patches the target and prints the line", async () => {
    const { seen, out, run } = harness();
    expect(await run("ssh", "target", "update", "nas", "--node", "pi")).toBe(0);
    expect(seen.filter((item) => item.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/cli/api/ssh/targets/nas", body: '{"nodes":["pi"]}' },
    ]);
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
