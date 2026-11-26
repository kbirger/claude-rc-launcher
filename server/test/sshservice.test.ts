import { describe, expect, spyOn, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { HostError } from "../src/hostclient";
import type { HostClient } from "../src/hostclient";
import { GrantError, GrantStore } from "../src/sshgrants";
import type { Grant } from "../src/sshgrants";
import { SshKeyStore } from "../src/sshkeystore";
import type { UnlockSecret } from "../src/sshkeystore";
import type { SshRunner } from "../src/sshmaintenance";
import { NodeError, SshService } from "../src/sshservice";
import { TargetError, TargetStore } from "../src/sshtargets";
import type { Target } from "../src/sshtargets";
import { newRecovery } from "../src/sshwrap";
import { fakeTimers } from "./faketimers";
import { fakeRunner } from "./sshrunner";
import { rejection } from "./support";

const unlock: UnlockSecret = { method: "passphrase", secret: new TextEncoder().encode("correct horse") };
const wrong: UnlockSecret = { method: "passphrase", secret: new TextEncoder().encode("wrong") };
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHostKeyHostKeyHostKeyHostKeyHostKeyHost";

interface Call {
  method: string;
  path: string;
  json?: unknown;
}
type Reply = { status: number; body?: unknown } | Error;
type Replies = Record<string, Reply | ((call: Call) => Reply) | undefined>;

/** A node that records each call. `replies` is keyed by `METHOD path`, with `:id` style segments matched by prefix. */
function fakeNode(replies: Replies = {}) {
  const calls: Call[] = [];
  const client: HostClient = {
    call: (method, path, options) => {
      const call: Call = { method, path, ...(options?.json !== undefined ? { json: options.json } : {}) };
      calls.push(call);
      const key = `${method} ${path}`;
      const found = replies[key] ?? Object.entries(replies).find(([pattern]) => matches(pattern, key))?.[1];
      const reply = typeof found === "function" ? found(call) : (found ?? { status: 204 });
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ status: reply.status, body: reply.body ?? null });
    },
    stream: () => Promise.reject(new Error("no stream")),
  };
  return { calls, client, paths: () => calls.map((call) => `${call.method} ${call.path}`) };
}

/** A pattern like `POST /api/ssh/grants/:id/probe` matches `POST /api/ssh/grants/abc/probe`. */
function matches(pattern: string, key: string): boolean {
  if (!pattern.includes(":")) return false;
  const regex = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
  return regex.test(key);
}

const flush = async () => {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
};

async function setup(
  options: {
    nodes?: Record<string, ReturnType<typeof fakeNode>>;
    state?: "ready" | "draft" | "disabled";
    notify?: (grant: Grant, target: Target) => void;
    notifyClose?: (grant: Grant) => void;
  } = {},
) {
  const timers = fakeTimers(1_000_000);
  const audit: string[] = [];
  const nodes = options.nodes ?? { node1: fakeNode() };
  const keys = new SshKeyStore();
  const recovery = newRecovery();
  await keys.setup({ method: "passphrase", recoveryPublicKey: recovery.publicKey });
  await keys.create("nas", unlock);
  const targets = new TargetStore();
  await targets.add({
    id: "nas",
    address: "10.0.0.5",
    port: 2222,
    account: "root",
    systemType: "linux",
    nodes: ["node1"],
  });
  await targets.setHostKey("nas", HOST_KEY);
  await targets.setState("nas", options.state ?? "ready");
  await targets.setNodeAccess("node1", { enabled: true, sourceAddress: "192.168.1.10" });

  const hook: { service?: SshService } = {};
  const grants = new GrantStore({
    now: () => timers.now(),
    timers,
    audit: (line) => audit.push(line),
    onEnd: (grant) => hook.service?.onGrantEnd(grant),
    onLeavePending: (grant) => hook.service?.onGrantLeavePending(grant),
  });
  const service = new SshService({
    keys,
    targets,
    grants,
    client: (hostId) => (nodes as Partial<typeof nodes>)[hostId]?.client,
    audit: (line) => audit.push(line),
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.notifyClose ? { notifyClose: options.notifyClose } : {}),
  });
  hook.service = service;
  return { service, keys, targets, grants, nodes, audit, timers, recovery, node: nodes.node1 };
}

const request = (extra: Record<string, unknown> = {}) => ({
  requestId: "req1",
  instanceId: "inst1",
  targetId: "nas",
  ...extra,
});

describe("SshService requests", () => {
  test("a real request calls notify once with the grant and the target", async () => {
    const sent: [Grant, Target][] = [];
    const { service, grants } = await setup({ notify: (grant, target) => sent.push([grant, target]) });
    service.onNodeEvent("node1", "ssh.request", request({ minutes: 30, reason: "deploy" }));
    await flush();
    const [grant] = grants.list();
    expect(sent).toHaveLength(1);
    expect(sent[0][0].id).toBe(grant.id);
    expect(sent[0][1].id).toBe("nas");
  });

  test("a request that grants.request refuses does not call notify again", async () => {
    const sent: Grant[] = [];
    const { service, grants } = await setup({ notify: (grant) => sent.push(grant) });
    service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    // minutes 0 makes grants.request throw, and notify must come after it.
    service.onNodeEvent("node1", "ssh.request", request({ requestId: "req2", minutes: 0 }));
    await flush();
    expect(grants.list()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test("a test grant does not call notify", async () => {
    const sent: Grant[] = [];
    const node = fakeNode({ "POST /api/ssh/grants/:id/probe": { status: 200, body: { code: 0, stderr: "" } } });
    const { service } = await setup({ nodes: { node1: node }, notify: (grant) => sent.push(grant) });
    await service.test("nas", "node1", "admin", unlock).catch(() => undefined);
    expect(sent).toEqual([]);
  });

  test("a grant that leaves pending sends one close, and the end of the active grant sends none", async () => {
    const closed: Grant[] = [];
    const ctx = await setup({ notifyClose: (grant) => closed.push(grant) });
    ctx.service.onNodeEvent("node1", "ssh.request", request({ minutes: 30 }));
    await flush();
    const [grant] = ctx.grants.list();
    await ctx.service.approve(grant.id, "alice", unlock);
    expect(closed.map((item) => item.id)).toEqual([grant.id]);
    ctx.grants.revoke(grant.id, "alice");
    expect(closed).toHaveLength(1);
  });

  test("a denied request sends one close", async () => {
    const closed: Grant[] = [];
    const ctx = await setup({ notifyClose: (grant) => closed.push(grant) });
    ctx.service.onNodeEvent("node1", "ssh.request", request({ minutes: 30 }));
    await flush();
    const [grant] = ctx.grants.list();
    ctx.grants.deny(grant.id, "alice");
    expect(closed).toHaveLength(1);
  });

  test("a test grant sends no close, and a throwing close is audited", async () => {
    const closed: Grant[] = [];
    const ctx = await setup({ notifyClose: (grant) => closed.push(grant) });
    ctx.service.onGrantLeavePending({ id: "t", test: true } as Grant);
    expect(closed).toEqual([]);

    const bad = await setup({
      notifyClose: () => {
        throw new Error("boom");
      },
    });
    bad.service.onGrantLeavePending({ id: "g", test: false } as Grant);
    expect(bad.audit.some((line) => line.includes("notify close failed"))).toBe(true);
  });

  test("a refused request does not call notify", async () => {
    const sent: Grant[] = [];
    const { service } = await setup({ state: "draft", notify: (grant) => sent.push(grant) });
    service.onNodeEvent("node1", "ssh.request", request());
    service.onNodeEvent("node2", "ssh.request", request());
    await flush();
    expect(sent).toEqual([]);
  });

  test("a throwing notify does not fail the request", async () => {
    const { service, grants, audit, node } = await setup({
      notify: () => {
        throw new Error("push is down");
      },
    });
    service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    expect(grants.list()).toHaveLength(1);
    expect(node.paths()).toEqual([]);
    expect(audit.some((line) => line.includes("notify failed"))).toBe(true);
  });

  test("an ssh.request event makes a pending grant for that node and instance", async () => {
    const { service, grants } = await setup();
    service.onNodeEvent("node1", "ssh.request", request({ minutes: 30, reason: "deploy" }));
    await flush();
    const [grant] = grants.list();
    expect(grant).toMatchObject({
      nodeId: "node1",
      instanceId: "inst1",
      targetId: "nas",
      requestId: "req1",
      minutes: 30,
      reason: "deploy",
      state: "pending",
    });
  });

  test("an ssh.request for a target that does not list the node is dropped and audited", async () => {
    const other = fakeNode();
    const { service, grants, audit, nodes } = await setup({ nodes: { node1: fakeNode(), node2: other } });
    expect(nodes.node2).toBe(other);
    service.onNodeEvent("node2", "ssh.request", request());
    await flush();
    expect(grants.list()).toHaveLength(0);
    expect(audit.some((line) => line.includes("dropped") && line.includes("node2"))).toBe(true);
    // The node is told, so that its instance does not wait for the time-out.
    expect(other.paths()).toEqual(["POST /api/ssh/requests/req1/reject"]);
  });

  test("an ssh.request for a disabled target is dropped", async () => {
    const { service, grants, audit } = await setup({ state: "disabled" });
    service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    expect(grants.list()).toHaveLength(0);
    expect(audit.some((line) => line.includes("dropped"))).toBe(true);
  });

  test("a bad ssh.request event is dropped without a throw", async () => {
    const { service, grants } = await setup();
    service.onNodeEvent("node1", "ssh.request", { requestId: 5 });
    service.onNodeEvent("node1", "ssh.request", null);
    service.onNodeEvent("node1", "ssh.other", {});
    await flush();
    expect(grants.list()).toHaveLength(0);
  });
});

describe("SshService approve", () => {
  async function pending() {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    return { ...ctx, grant };
  }

  test("approve with a wrong unlock leaves the grant pending and holds no key", async () => {
    const { service, grants, grant, node } = await pending();
    const error = await service.approve(grant.id, "alice", wrong).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GrantError);
    expect((error as GrantError).status).toBe(403);
    expect(grants.get(grant.id)?.state).toBe("pending");
    expect(() => grants.sign(grant.id, new Uint8Array(1), new Uint8Array(1))).toThrow(GrantError);
    expect(node.calls).toHaveLength(0);
  });

  test("approve activates and calls POST /ssh/grants once", async () => {
    const { service, grants, grant, node, keys } = await pending();
    const active = await service.approve(grant.id, "alice", unlock, 20);
    expect(active.state).toBe("active");
    expect(active.minutes).toBe(20);
    expect(grants.get(grant.id)?.state).toBe("active");
    expect(node.paths()).toEqual(["POST /api/ssh/grants"]);
    const body = node.calls[0].json as Record<string, unknown>;
    const open = await keys.open("nas", unlock);
    expect(body).toEqual({
      grantId: grant.id,
      requestId: "req1",
      instanceId: "inst1",
      targetId: "nas",
      publicKey: Buffer.from(open.publicBlob).toString("base64"),
      address: "10.0.0.5",
      port: 2222,
      account: "root",
      hostKey: HOST_KEY,
      endsAt: active.endsAt,
    });
    open.destroy();
  });

  test("approve when the node call fails ends the grant with node-lost", async () => {
    const nodes = { node1: fakeNode({ "POST /api/ssh/grants": new HostError("node1", "unreachable") }) };
    const ctx = await setup({ nodes });
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    const error = await ctx.service.approve(grant.id, "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GrantError);
    expect(ctx.grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
    expect(() => ctx.grants.sign(grant.id, new Uint8Array(1), new Uint8Array(1))).toThrow(GrantError);
  });

  test("approve when the node answers with an error status ends the grant with node-lost", async () => {
    const nodes = { node1: fakeNode({ "POST /api/ssh/grants": { status: 500, body: { error: "boom" } } }) };
    const ctx = await setup({ nodes });
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    const error = await ctx.service.approve(grant.id, "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("boom");
    expect(ctx.grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
  });

  test("approve says in plain words that the session stopped waiting when the node has no waiting request", async () => {
    const nodes = {
      node1: fakeNode({ "POST /api/ssh/grants": { status: 409, body: { error: "no request waits for this answer" } } }),
    };
    const ctx = await setup({ nodes });
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    const error = await ctx.service.approve(grant.id, "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GrantError);
    expect((error as GrantError).status).toBe(409);
    expect((error as Error).message).toBe("The session stopped waiting. Ask the session to request again.");
    expect(ctx.grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
  });

  test("approve refuses a target without a pinned host key and keeps the grant pending", async () => {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    const bare = new TargetStore();
    await bare.add({
      id: "nas",
      address: "10.0.0.5",
      port: 22,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    const service = new SshService({
      keys: ctx.keys,
      targets: bare,
      grants: ctx.grants,
      client: () => ctx.node.client,
      audit: () => undefined,
    });
    const error = await service.approve(grant.id, "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TargetError);
    expect((error as TargetError).status).toBe(409);
    expect(ctx.grants.get(grant.id)?.state).toBe("pending");
  });
});

describe("SshService sign", () => {
  async function active() {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    await ctx.service.approve(grant.id, "alice", unlock);
    ctx.node.calls.length = 0;
    const key = await ctx.keys.open("nas", unlock);
    return { ...ctx, grant, key };
  }

  const signEvent = (grantId: string, blob: Uint8Array, data: Uint8Array) => ({
    signId: "sign1",
    grantId,
    keyBlob: Buffer.from(blob).toString("base64"),
    data: Buffer.from(data).toString("base64"),
    flags: 0,
  });

  test("an ssh.sign event for an active grant calls sign-result with a signature", async () => {
    const { service, grant, key, node } = await active();
    const data = new TextEncoder().encode("to be signed");
    service.onNodeEvent("node1", "ssh.sign", signEvent(grant.id, key.publicBlob, data));
    await flush();
    expect(node.paths()).toEqual(["POST /api/ssh/sign-result"]);
    const body = node.calls[0].json as { signId: string; signature: string; error?: string };
    expect(body.signId).toBe("sign1");
    expect(body.error).toBeUndefined();
    const signature = Buffer.from(body.signature, "base64");
    expect(signature).toHaveLength(64);
    const raw = key.publicBlob.subarray(key.publicBlob.length - 32);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    expect(verify(null, data, createPublicKey({ key: spki, format: "der", type: "spki" }), signature)).toBe(true);
  });

  test("an ssh.sign event for an ended grant calls sign-result with an error", async () => {
    const { service, grant, grants, key, node } = await active();
    grants.revoke(grant.id, "alice");
    await flush();
    node.calls.length = 0;
    service.onNodeEvent("node1", "ssh.sign", signEvent(grant.id, key.publicBlob, new Uint8Array(4)));
    await flush();
    expect(node.paths()).toEqual(["POST /api/ssh/sign-result"]);
    const body = node.calls[0].json as { signId: string; signature?: string; error: string };
    expect(body.signId).toBe("sign1");
    expect(body.signature).toBeUndefined();
    expect(body.error).toContain("ended");
  });

  test("an ssh.sign event from another node is refused", async () => {
    const other = fakeNode();
    const ctx = await setup({ nodes: { node1: fakeNode(), node2: other } });
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    await ctx.service.approve(grant.id, "alice", unlock);
    const key = await ctx.keys.open("nas", unlock);
    ctx.service.onNodeEvent("node2", "ssh.sign", signEvent(grant.id, key.publicBlob, new Uint8Array(4)));
    await flush();
    const body = other.calls[0].json as { signature?: string; error?: string };
    expect(body.signature).toBeUndefined();
    expect(body.error).toBeTruthy();
  });
});

describe("SshService node presence", () => {
  test("onNodeOnline calls POST /ssh/reset", async () => {
    const { service, node } = await setup();
    await service.onNodeOnline("node1");
    expect(node.paths()[0]).toBe("POST /api/ssh/reset");
  });

  test("onNodeOnline pushes the targets of that node after the reset", async () => {
    const ctx = await setup();
    await ctx.targets.add({
      id: "pi",
      address: "pi.lan",
      port: 22,
      account: "pi",
      systemType: "linux",
      nodes: ["node1"],
    });
    await ctx.targets.add({
      id: "off",
      address: "off.lan",
      port: 22,
      account: "o",
      systemType: "linux",
      nodes: ["node1"],
    });
    await ctx.targets.setState("off", "disabled");
    await ctx.targets.add({
      id: "away",
      address: "away.lan",
      port: 22,
      account: "a",
      systemType: "linux",
      nodes: ["node2"],
    });
    await ctx.service.onNodeOnline("node1");
    expect(ctx.node.paths()).toEqual(["POST /api/ssh/reset", "PUT /api/ssh/targets"]);
    expect(ctx.node.calls[1].json).toEqual({
      // "pi" is a draft: only a target that passed its test can be requested.
      targets: [{ id: "nas", account: "root", address: "10.0.0.5" }],
    });
  });

  test("onNodeOnline does not throw when the node is gone, and audits it", async () => {
    const nodes = { node1: fakeNode({ "POST /api/ssh/reset": new HostError("node1", "unreachable") }) };
    const { service, audit } = await setup({ nodes });
    await service.onNodeOnline("node1");
    expect(audit.some((line) => line.includes("reset"))).toBe(true);
  });

  test("onNodeOffline ends the active grants of that node", async () => {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    await ctx.service.approve(grant.id, "alice", unlock);
    ctx.service.onNodeOffline("node1");
    expect(ctx.grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
  });
});

describe("SshService blips", () => {
  async function mixed() {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request({ requestId: "a" }));
    ctx.service.onNodeEvent("node1", "ssh.request", request({ requestId: "b" }));
    await flush();
    const [first, second] = ctx.grants.list();
    await ctx.service.approve(first.id, "alice", unlock);
    ctx.node.calls.length = 0;
    return { ...ctx, active: first, pending: second };
  }

  test("onNodeOffline ends the active grant and keeps the pending one, with no reject call", async () => {
    const ctx = await mixed();
    ctx.service.onNodeOffline("node1");
    await flush();
    expect(ctx.grants.get(ctx.active.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
    expect(ctx.grants.get(ctx.pending.id)?.state).toBe("pending");
    expect(ctx.node.paths().some((path) => path.includes("/requests/"))).toBe(false);
  });

  test("onNodeOnline ends the active grant and keeps the pending one, with no reject call", async () => {
    const ctx = await mixed();
    await ctx.service.onNodeOnline("node1");
    expect(ctx.grants.get(ctx.active.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
    expect(ctx.grants.get(ctx.pending.id)?.state).toBe("pending");
    expect(ctx.node.paths().some((path) => path.includes("/requests/"))).toBe(false);
  });
});

describe("SshService test", () => {
  const probeOk = { "POST /api/ssh/grants/:id/probe": { status: 200, body: { code: 0, stderr: "" } } };

  test("test makes a one-minute grant with the instance id test, approves it, probes it and ends it", async () => {
    const nodes = { node1: fakeNode(probeOk) };
    const ctx = await setup({ nodes });
    await ctx.service.test("nas", "node1", "alice", unlock);
    const [grant] = ctx.grants.list();
    expect(grant).toMatchObject({ instanceId: "test", minutes: 1, test: true, state: "ended", endReason: "revoked" });
    const paths = ctx.node.paths();
    expect(paths[0]).toBe("POST /api/ssh/grants");
    expect(paths[1]).toBe(`POST /api/ssh/grants/${grant.id}/probe`);
    // The target is ready now: the node gets the new list of targets, and then the grant ends.
    expect(paths[2]).toBe("PUT /api/ssh/targets");
    expect(paths[3]).toBe(`DELETE /api/ssh/grants/${grant.id}`);
    expect((ctx.node.calls[0].json as { instanceId: string }).instanceId).toBe("test");
    expect(ctx.node.calls[0].json as Record<string, unknown>).not.toHaveProperty("requestId");
  });

  test("test sets the target to ready when the probe exits 0", async () => {
    const ctx = await setup({ nodes: { node1: fakeNode(probeOk) }, state: "draft" });
    expect(await ctx.service.test("nas", "node1", "alice", unlock)).toEqual({ ok: true });
    expect(ctx.targets.get("nas")?.state).toBe("ready");
  });

  test("test returns the stderr text and keeps the state when the probe fails", async () => {
    const nodes = {
      node1: fakeNode({
        "POST /api/ssh/grants/:id/probe": { status: 200, body: { code: 255, stderr: "Permission denied\n" } },
      }),
    };
    const ctx = await setup({ nodes, state: "draft" });
    expect(await ctx.service.test("nas", "node1", "alice", unlock)).toEqual({ ok: false, error: "Permission denied" });
    expect(ctx.targets.get("nas")?.state).toBe("draft");
    expect(ctx.grants.list()[0]?.state).toBe("ended");
  });

  test("test with a wrong unlock throws 403 and leaves no pending grant", async () => {
    const ctx = await setup({ nodes: { node1: fakeNode(probeOk) } });
    const error = await ctx.service.test("nas", "node1", "alice", wrong).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GrantError);
    expect((error as GrantError).status).toBe(403);
    expect(ctx.grants.list().every((grant) => grant.state === "ended")).toBe(true);
  });

  test("test refuses a node that the target does not list", async () => {
    const ctx = await setup({ nodes: { node1: fakeNode(), node2: fakeNode() } });
    const error = await ctx.service.test("nas", "node2", "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TargetError);
    expect(ctx.grants.list()).toHaveLength(0);
  });
});

describe("SshService grant end", () => {
  test("a pending grant that ends calls POST /ssh/requests/:requestId/reject", async () => {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    ctx.grants.deny(ctx.grants.list()[0].id, "alice");
    await flush();
    expect(ctx.node.paths()).toEqual(["POST /api/ssh/requests/req1/reject"]);
    expect(typeof (ctx.node.calls[0].json as { reason: unknown }).reason).toBe("string");
  });

  test("an active grant that ends calls DELETE /ssh/grants/:id", async () => {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = ctx.grants.list()[0];
    await ctx.service.approve(grant.id, "alice", unlock);
    ctx.node.calls.length = 0;
    await ctx.service.revoke(grant.id, "alice");
    await flush();
    expect(ctx.node.paths()).toEqual([`DELETE /api/ssh/grants/${grant.id}`]);
  });

  test("a failing node call does not stop endWhere from ending the other grants", async () => {
    const nodes = { node1: fakeNode({ "DELETE /api/ssh/grants/:id": new HostError("node1", "unreachable") }) };
    const ctx = await setup({ nodes });

    for (const requestId of ["a", "b", "c"]) {
      ctx.service.onNodeEvent("node1", "ssh.request", request({ requestId }));
      await flush();
    }

    for (const grant of ctx.grants.list()) await ctx.service.approve(grant.id, "alice", unlock);
    const ended = ctx.grants.endWhere(() => true, "hub-restart");
    await flush();
    expect(ended).toHaveLength(3);
    expect(ctx.grants.list().every((grant) => grant.state === "ended")).toBe(true);
    expect(ctx.audit.filter((line) => line.includes("node call failed"))).toHaveLength(3);
  });

  test("onGrantEnd for a grant of an unknown node does not throw", async () => {
    const ctx = await setup();
    expect(() => {
      ctx.service.onGrantEnd({
        id: "g1",
        nodeId: "gone",
        instanceId: "i",
        targetId: "nas",
        minutes: 1,
        test: false,
        state: "ended",
        requestedAt: 0,
        approvedAt: 1,
        endReason: "revoked",
      });
    }).not.toThrow();
  });
});

describe("SshService managed targets", () => {
  async function managed(replies: Replies = {}) {
    const host = fakeNode(replies);
    const ctx = await setup({ nodes: { node1: fakeNode(), pve: host } });
    await ctx.targets.add({
      id: "pve",
      address: "10.0.0.9",
      port: 22,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "pve",
    });
    await ctx.keys.create("pve", unlock);
    return { ...ctx, host };
  }

  test("pinManaged stores the host key from GET /ssh/hostkey", async () => {
    const line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinnedPinnedPinnedPinnedPinnedPinnedPinned";
    const { service, targets, host } = await managed({
      "GET /api/ssh/hostkey": { status: 200, body: { keys: [{ line, fingerprint: "SHA256:abc" }] } },
    });
    const keys = await service.pinManaged("pve");
    expect(keys).toEqual([{ line, fingerprint: "SHA256:abc" }]);
    expect(targets.get("pve")?.hostKey).toBe(line);
    expect(host.paths()).toEqual(["GET /api/ssh/hostkey"]);
  });

  test("authorizeManaged sends the account, the system type and the install line", async () => {
    const { service, keys, host } = await managed();
    await service.authorizeManaged("pve");
    expect(host.paths()).toEqual(["POST /api/ssh/authorize"]);
    expect(host.calls[0].json).toEqual({
      account: "root",
      systemType: "linux",
      line: `from="192.168.1.10",restrict ${keys.publicLine("pve")}`,
    });
  });

  test("authorizeManaged and deauthorizeManaged send the key file of the target, and send none without one", async () => {
    const { service, targets, keys, host } = await managed({
      "POST /api/ssh/deauthorize": { status: 200, body: { result: "removed" } },
      "POST /api/ssh/authorize": (call) => {
        const keyFile = (call.json as { keyFile?: string }).keyFile;
        return keyFile === undefined ? { status: 204 } : { status: 200, body: { keyFile } };
      },
    });
    await service.authorizeManaged("pve");
    await service.deauthorizeManaged("pve");
    expect(host.calls[0].json).not.toHaveProperty("keyFile");
    expect(host.calls[1].json).not.toHaveProperty("keyFile");

    await targets.add({
      id: "alt",
      address: "10.0.0.10",
      port: 22,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "pve",
      keyFile: "authorized_keys2",
    });
    await keys.create("alt", unlock);
    await service.authorizeManaged("alt");
    expect(host.calls[2].json).toMatchObject({ account: "root", keyFile: "authorized_keys2" });
    expect(await service.deauthorizeManaged("alt")).toEqual({ line: "removed" });
    expect(host.calls[3].json).toMatchObject({ id: "alt", keyFile: "authorized_keys2" });
  });

  describe("authorizeManaged with a key file", () => {
    async function withKeyFile(reply: Reply) {
      const ctx = await managed({ "POST /api/ssh/authorize": reply });
      await ctx.targets.add({
        id: "alt",
        address: "10.0.0.10",
        port: 22,
        account: "root",
        systemType: "linux",
        nodes: ["node1"],
        managedHost: "pve",
        keyFile: "authorized_keys2",
      });
      await ctx.keys.create("alt", unlock);
      const error = await ctx.service.authorizeManaged("alt").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      return { ...ctx, error };
    }

    test("a node that names the same file back is a success", async () => {
      const { error } = await withKeyFile({ status: 200, body: { keyFile: "authorized_keys2" } });
      expect(error).toBeUndefined();
    });

    test("an old node that answers 204 without a body fails with a plain text", async () => {
      const { error, targets } = await withKeyFile({ status: 204 });
      expect(error).toBeInstanceOf(NodeError);
      expect((error as Error).message).toContain("the node does not know key files: update the node first");
      expect(targets.get("alt")?.state).toBe("draft");
    });

    test("a node that answers another file name fails", async () => {
      const { error, targets } = await withKeyFile({ status: 200, body: { keyFile: "authorized_keys" } });
      expect(error).toBeInstanceOf(NodeError);
      expect(targets.get("alt")?.state).toBe("draft");
    });
  });

  test("authorizeManaged without an enabled node address is a 409", async () => {
    const { service, targets, host } = await managed();
    await targets.setNodeAccess("node1", { enabled: false, sourceAddress: "192.168.1.10" });
    const error = await service.authorizeManaged("pve").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TargetError);
    expect((error as TargetError).status).toBe(409);
    expect(host.calls).toHaveLength(0);
  });

  test("pinManaged and authorizeManaged on an external target throw 409", async () => {
    const { service } = await setup();

    for (const run of [() => service.pinManaged("nas"), () => service.authorizeManaged("nas")]) {
      const error = await run().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TargetError);
      expect((error as TargetError).status).toBe(409);
    }
  });

  test("scanHostKey calls POST /ssh/scan on the node with the address and port", async () => {
    const keys = [{ line: HOST_KEY, fingerprint: "SHA256:zzz" }];
    const nodes = { node1: fakeNode({ "POST /api/ssh/scan": { status: 200, body: { keys } } }) };
    const ctx = await setup({ nodes });
    expect(await ctx.service.scanHostKey("nas", "node1")).toEqual(keys);
    expect(ctx.node.calls[0].json).toEqual({ address: "10.0.0.5", port: 2222 });
  });
});

describe("SshService ends grants when a node or an instance goes away", () => {
  test("onNodeRemoved ends the active and the pending grants of that node with node-lost", async () => {
    const ctx = await setup();
    const active = ctx.grants.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas" });
    await ctx.service.approve(active.id, "alice", unlock);
    const pending = ctx.grants.request({ nodeId: "node1", instanceId: "inst2", targetId: "nas" });
    const other = ctx.grants.request({ nodeId: "node2", instanceId: "inst1", targetId: "nas" });
    ctx.service.onNodeRemoved("node1");
    expect(ctx.grants.get(active.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
    expect(ctx.grants.get(pending.id)).toMatchObject({ state: "ended", endReason: "node-lost" });
    expect(ctx.grants.get(other.id)?.state).toBe("pending");
  });

  test("an ssh.instance-off event ends the grants of that instance with revoked and tells the node", async () => {
    const ctx = await setup();
    ctx.service.onNodeEvent("node1", "ssh.request", request({ requestId: "r1" }));
    ctx.service.onNodeEvent("node1", "ssh.request", request({ requestId: "r2", instanceId: "inst2" }));
    await flush();
    const first = ctx.grants.list().find((grant) => grant.requestId === "r1");
    await ctx.service.approve(first?.id ?? "", "alice", unlock);
    const pending = ctx.grants.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas", requestId: "r3" });
    ctx.service.onNodeEvent("node1", "ssh.instance-off", { instanceId: "inst1" });
    await flush();
    expect(ctx.grants.get(first?.id ?? "")).toMatchObject({ state: "ended", endReason: "revoked" });
    expect(ctx.grants.get(pending.id)).toMatchObject({ state: "ended", endReason: "revoked" });
    expect(ctx.grants.list().find((grant) => grant.requestId === "r2")?.state).toBe("pending");
    expect(ctx.node.paths()).toContain(`DELETE /api/ssh/grants/${first?.id ?? ""}`);
    expect(ctx.node.paths()).toContain("POST /api/ssh/requests/r3/reject");
  });

  test("an ssh.instance-off event from another node ends nothing", async () => {
    const ctx = await setup({ nodes: { node1: fakeNode(), node2: fakeNode() } });
    const pending = ctx.grants.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas" });
    ctx.service.onNodeEvent("node2", "ssh.instance-off", { instanceId: "inst1" });
    ctx.service.onNodeEvent("node1", "ssh.instance-off", { instanceId: 5 });
    await flush();
    expect(ctx.grants.get(pending.id)?.state).toBe("pending");
  });
});

describe("SshService approve races", () => {
  /** Holds `keys.open` until `release` runs, and records every key that it gives out. */
  function slowOpen(ctx: Awaited<ReturnType<typeof setup>>) {
    const opened: { sign: (data: Uint8Array) => Uint8Array }[] = [];

    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => (release = resolve));
    const realOpen = ctx.keys.open.bind(ctx.keys);

    ctx.keys.open = async (targetId, secret) => {
      const key = await realOpen(targetId, secret);
      opened.push(key);
      await gate;
      return key;
    };

    return {
      opened,
      release: () => {
        release();
      },
    };
  }

  async function race(during: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    const ctx = await setup();
    const grant = ctx.grants.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas", requestId: "r1" });
    const slow = slowOpen(ctx);
    const approving = ctx.service.approve(grant.id, "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await flush();
    await during(ctx);
    slow.release();
    const error = await approving;
    return { ctx, grant, error, opened: slow.opened };
  }

  const expectRefused = (result: Awaited<ReturnType<typeof race>>, text: string) => {
    expect(result.error).toBeInstanceOf(TargetError);
    expect((result.error as TargetError).status).toBe(409);
    expect((result.error as TargetError).message).toBe(text);
    expect(result.ctx.grants.list().some((grant) => grant.state === "active")).toBe(false);
    expect(result.opened).toHaveLength(1);
    expect(() => result.opened[0]?.sign(new Uint8Array(1))).toThrow();
    expect(result.ctx.node.paths()).not.toContain("POST /api/ssh/grants");
  };

  test("a disable during the derive gives 409, holds no key and leaves no active grant", async () => {
    expectRefused(await race((ctx) => ctx.targets.setState("nas", "disabled")), "the target is disabled");
  });

  test("a retire during the derive gives 404, holds no key and leaves no active grant", async () => {
    const result = await race((ctx) => ctx.targets.remove("nas"));
    expect(result.error).toBeInstanceOf(TargetError);
    expect((result.error as TargetError).status).toBe(404);
    expect((result.error as TargetError).message).toBe("no such target");
    expect(result.ctx.grants.list().some((grant) => grant.state === "active")).toBe(false);
    expect(result.opened).toHaveLength(1);
    expect(() => result.opened[0]?.sign(new Uint8Array(1))).toThrow();
    expect(result.ctx.node.paths()).not.toContain("POST /api/ssh/grants");
  });

  test("a recovery begin during the derive gives 409, holds no key and leaves no active grant", async () => {
    const result = await race(async (ctx) => {
      await ctx.keys.beginRecovery({ code: ctx.recovery.code, method: "passphrase" });
    });
    expectRefused(result, "this target needs its key to be recovered");
  });

  test("a revoke while POST /grants is in flight sends DELETE after the POST", async () => {
    const hook: { revoke?: () => void } = {};
    const node = fakeNode({
      "POST /api/ssh/grants": () => {
        hook.revoke?.();
        return { status: 200, body: { socket: "/s", config: "/c" } };
      },
    });
    const ctx = await setup({ nodes: { node1: node } });
    const grant = ctx.grants.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas" });
    hook.revoke = () => ctx.grants.revoke(grant.id, "bob");
    await ctx.service.approve(grant.id, "alice", unlock);
    await flush();
    const paths = node.paths();
    // One DELETE from the revoke, which can reach the node before the grant exists there, and one after the POST.
    expect(paths.filter((path) => path === `DELETE /api/ssh/grants/${grant.id}`)).toHaveLength(2);
    expect(paths.at(-1)).toBe(`DELETE /api/ssh/grants/${grant.id}`);
  });
});

describe("SshService drafts and source addresses", () => {
  test("an ssh.request for a draft target is refused and the node is told", async () => {
    const ctx = await setup({ state: "draft" });
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    expect(ctx.grants.list()).toHaveLength(0);
    expect(ctx.node.paths()).toEqual(["POST /api/ssh/requests/req1/reject"]);
    expect(ctx.node.calls[0]?.json).toEqual({ reason: "the target is draft" });
  });

  test("approve refuses a real grant for a draft target; only the test grant may use it", async () => {
    const ctx = await setup({ state: "draft" });
    const grant = ctx.grants.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas" });
    const error = await ctx.service.approve(grant.id, "alice", unlock).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TargetError);
    expect((error as TargetError).message).toBe("the target is draft");
    expect(ctx.grants.get(grant.id)?.state).toBe("pending");
    expect(ctx.node.calls).toHaveLength(0);
  });

  test("pushTargets lists only ready targets, and a test that passes pushes the new ready target", async () => {
    const ctx = await setup({
      nodes: { node1: fakeNode({ "POST /api/ssh/grants/:id/probe": { status: 200, body: { code: 0, stderr: "" } } }) },
      state: "draft",
    });
    await ctx.service.pushTargets("node1");
    expect(ctx.node.calls[0]?.json).toEqual({ targets: [] });
    expect(await ctx.service.test("nas", "node1", "alice", unlock)).toEqual({ ok: true });
    await flush();
    const pushes = ctx.node.calls.filter((call) => call.method === "PUT");
    expect(pushes.at(-1)?.json).toEqual({ targets: [{ id: "nas", account: "root", address: "10.0.0.5" }] });
  });

  test("a failed reject reply of a refused request is audited", async () => {
    const node = fakeNode({ "POST /api/ssh/requests/:id/reject": { status: 500, body: { error: "broken" } } });
    const ctx = await setup({ nodes: { node1: node }, state: "disabled" });
    ctx.service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    expect(ctx.audit.some((line) => line.includes("reject failed") && line.includes("broken"))).toBe(true);
  });

  test("authorizeManaged with an enabled node that has no source address is a 409 with the usual text", async () => {
    const ctx = await setup();
    await ctx.targets.add({
      id: "self",
      address: "10.0.0.9",
      port: 22,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "node1",
    });
    ctx.targets.nodeAccess = () => ({ enabled: true, sourceAddress: "" });
    const error = await ctx.service.authorizeManaged("self").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TargetError);
    expect((error as TargetError).status).toBe(409);
    expect((error as TargetError).message).toBe("no node of this target has access enabled with a source address");
  });
});

const LOCAL_SOURCE = "192.168.1.103";
const SCRIPT = "/home/u/.claude-rc/provisioner-nas.sh";
const CONFIG = "/run/rc-ssh/maintenance/g.config";

async function maintenanceSetup(
  options: {
    state?: "ready" | "draft" | "disabled";
    runner?: ReturnType<typeof fakeRunner>;
    hasSsh?: boolean;
    localReady?: boolean;
    local?: ReturnType<typeof fakeNode>;
    managed?: boolean;
    provisioner?: boolean;
    notifyMaintenance?: (grant: Grant, target: Target) => void;
    notifyClose?: (grant: Grant) => void;
    commitTimeoutMs?: number;
  } = {},
) {
  const timers = fakeTimers(1_000_000);
  const audit: string[] = [];
  const local =
    options.local ??
    fakeNode({
      "POST /api/ssh/grants": { status: 200, body: { socket: "/run/rc-ssh/maintenance/g.sock", config: CONFIG } },
    });
  const nodes: Partial<Record<string, ReturnType<typeof fakeNode>>> = { local, node1: fakeNode(), node2: fakeNode() };
  const keys = new SshKeyStore();
  const recovery = newRecovery();
  await keys.setup({ method: "passphrase", recoveryPublicKey: recovery.publicKey });
  const targets = new TargetStore();
  await targets.add({
    id: "nas",
    address: "10.0.0.5",
    port: 22,
    account: "u",
    systemType: "linux",
    nodes: ["node1"],
    ...(options.managed ? { managedHost: "node1" } : {}),
  });
  await keys.create("nas", unlock);
  await targets.setHostKey("nas", HOST_KEY);
  await targets.setState("nas", options.state ?? "ready");
  await targets.setNodeAccess("node1", { enabled: true, sourceAddress: "192.168.1.10" });
  await targets.setNodeAccess("node2", { enabled: true, sourceAddress: "192.168.1.20" });
  await targets.setNodeAccess("local", { enabled: true, sourceAddress: LOCAL_SOURCE });

  if (options.provisioner !== false && !options.managed) {
    const made = await keys.create("nas", unlock, "provisioner");
    await targets.setProvisioner("nas", { fingerprint: made.fingerprint, script: SCRIPT, source: LOCAL_SOURCE });
  }

  const runner = options.runner ?? fakeRunner();
  const hook: { service?: SshService } = {};
  const grants = new GrantStore({
    now: () => timers.now(),
    timers,
    audit: (line) => audit.push(line),
    onEnd: (grant) => hook.service?.onGrantEnd(grant),
    onLeavePending: (grant) => hook.service?.onGrantLeavePending(grant),
  });
  const opened: string[] = [];
  const realOpen = keys.open.bind(keys);

  keys.open = (targetId, secret, slot) => {
    slot ??= "main";
    opened.push(slot);
    return realOpen(targetId, secret, slot);
  };

  const service = new SshService({
    keys,
    targets,
    grants,
    client: (hostId) => nodes[hostId]?.client,
    audit: (line) => audit.push(line),
    runSsh: runner.runner,
    hasSsh: () => options.hasSsh ?? true,
    localReady: () => options.localReady ?? true,
    timers,
    ...(options.commitTimeoutMs !== undefined ? { commitTimeoutMs: options.commitTimeoutMs } : {}),
    ...(options.notifyMaintenance ? { notifyMaintenance: options.notifyMaintenance } : {}),
    ...(options.notifyClose ? { notifyClose: options.notifyClose } : {}),
  });
  hook.service = service;
  return { service, keys, targets, grants, local, nodes, audit, timers, runner, opened, recovery };
}

async function refusal(fn: () => unknown): Promise<{ status: number | undefined; message: string }> {
  try {
    await fn();
  } catch (error) {
    const status = (error as { status?: number }).status;
    return { status, message: error instanceof Error ? error.message : String(error) };
  }

  throw new Error("no refusal");
}

describe("SshService maintenance", () => {
  test("requestMaintenance calls notifyMaintenance once", async () => {
    const sent: [Grant, Target][] = [];
    const { service } = await maintenanceSetup({ notifyMaintenance: (grant, target) => sent.push([grant, target]) });
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0].id).toBe(grant.id);
    expect(sent[0]?.[1].id).toBe("nas");
  });

  test("a throwing notifyMaintenance does not fail the request", async () => {
    const { service, grants, audit } = await maintenanceSetup({
      notifyMaintenance: () => {
        throw new Error("boom");
      },
    });
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    expect(grants.get(grant.id)?.state).toBe("pending");
    expect(audit.some((line) => line.includes("notify failed"))).toBe(true);
  });

  test("the close message goes out when a maintenance grant leaves pending", async () => {
    const closed: Grant[] = [];
    const { service, grants } = await maintenanceSetup({ notifyClose: (grant) => closed.push(grant) });
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    grants.deny(grant.id, "admin");
    expect(closed.map((item) => item.id)).toEqual([grant.id]);
  });

  test("a node event with a maintenance field makes a plain grant", async () => {
    const { service, grants } = await maintenanceSetup();
    service.onNodeEvent(
      "node1",
      "ssh.request",
      request({ maintenance: { action: "uninstall", fromNodes: [], fromSources: [] } }),
    );
    await flush();
    const grant = grants.list().at(0);
    expect(grant?.state).toBe("pending");
    expect(grant?.maintenance).toBeUndefined();
    expect(grant?.minutes).toBe(60);
  });

  test("a plain grant never opens the provisioner slot", async () => {
    const { service, grants, opened, runner } = await maintenanceSetup();
    service.onNodeEvent("node1", "ssh.request", request());
    await flush();
    const grant = grants.list().at(0);
    const active = await service.approve(grant?.id ?? "", "admin", unlock);
    expect(active.state).toBe("active");
    expect(opened).toEqual(["main"]);
    expect(runner.calls).toHaveLength(0);
  });

  test("a maintenance grant never opens the main slot", async () => {
    const { service, opened } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    await service.approve(grant.id, "admin", unlock);
    expect(opened).toEqual(["provisioner"]);
  });

  for (const state of ["draft", "ready", "disabled"] as const) {
    test(`a maintenance grant is usable on a ${state} target`, async () => {
      const { service } = await maintenanceSetup({ state });
      const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
      const done = await service.approve(grant.id, "admin", unlock);
      expect(done.maintenance?.result).toBe("done");
    });
  }

  test("a maintenance grant goes to local with the provisioner blob and no requestId", async () => {
    const { service, keys, local } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    expect(grant).toMatchObject({ nodeId: "local", instanceId: "maintenance", minutes: 1, test: false });
    await service.approve(grant.id, "admin", unlock, 30);
    const post = local.calls.find((call) => call.method === "POST" && call.path === "/api/ssh/grants");
    const body = post?.json as Record<string, unknown>;
    expect(body.requestId).toBeUndefined();
    expect(body.instanceId).toBe("maintenance");
    expect(body.publicKey).toBe(keys.publicLine("nas", "provisioner").split(" ")[1]);
    expect(body.publicKey).not.toBe(keys.publicLine("nas").split(" ")[1]);
  });

  test("requestMaintenance refuses a managed target, a target without a provisioner and a second request", async () => {
    const managed = await maintenanceSetup({ managed: true });
    expect(
      await refusal(() => managed.service.requestMaintenance({ targetId: "nas", action: "install", by: "a" })),
    ).toEqual({ status: 409, message: "the target is a managed target" });
    const bare = await maintenanceSetup({ provisioner: false });
    expect(
      await refusal(() => bare.service.requestMaintenance({ targetId: "nas", action: "install", by: "a" })),
    ).toEqual({ status: 409, message: "this target has no provisioner" });
    const { service, grants } = await maintenanceSetup();
    service.requestMaintenance({ targetId: "nas", action: "install", by: "a" });
    expect(await refusal(() => service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "a" }))).toEqual({
      status: 409,
      message: "a maintenance request waits for this target",
    });
    expect(grants.list()).toHaveLength(1);
  });

  test("requestMaintenance refuses without ssh, without a local client and without a local source", async () => {
    const noSsh = await maintenanceSetup({ hasSsh: false });
    expect(
      await refusal(() => noSsh.service.requestMaintenance({ targetId: "nas", action: "install", by: "a" })),
    ).toEqual({ status: 409, message: "the hub has no ssh program: install the OpenSSH client on the hub machine" });
    const noLocal = await maintenanceSetup({ localReady: false });
    expect(
      await refusal(() => noLocal.service.requestMaintenance({ targetId: "nas", action: "install", by: "a" })),
    ).toEqual({ status: 501, message: "the hub cannot run maintenance on this system" });
    const off = await maintenanceSetup();
    await off.targets.setNodeAccess("local", { enabled: false, sourceAddress: LOCAL_SOURCE });
    expect(
      await refusal(() => off.service.requestMaintenance({ targetId: "nas", action: "install", by: "a" })),
    ).toEqual({
      status: 409,
      message: "turn on SSH access for the node local with a source address",
    });
    for (const item of [noSsh, noLocal, off]) expect(item.grants.list()).toHaveLength(0);
  });

  test("requestMaintenance refuses a stale local source with the repair command in the text", async () => {
    const { service, targets } = await maintenanceSetup();
    await targets.setNodeAccess("local", { enabled: true, sourceAddress: "192.168.1.104" });
    const { status, message } = await refusal(() =>
      service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "a" }),
    );
    expect(status).toBe(409);
    expect(message).toContain("claude-rc ssh target provisioner nas --identity <file>");
  });

  test("requestMaintenance refuses a target that waits for a re-lock", async () => {
    const { service, keys, recovery } = await maintenanceSetup();
    await keys.beginRecovery({ code: recovery.code, method: "passphrase" });
    expect(await refusal(() => service.requestMaintenance({ targetId: "nas", action: "install", by: "a" }))).toEqual({
      status: 409,
      message: "this target needs its key to be recovered",
    });
  });

  test("requestMaintenance takes only exact addresses for a new list, and toNodes only for sources", async () => {
    const { service, targets } = await maintenanceSetup();
    expect(
      (
        await refusal(() =>
          service.requestMaintenance({ targetId: "nas", action: "install", toNodes: ["node2"], by: "a" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await refusal(() => service.requestMaintenance({ targetId: "nas", action: "sources", by: "a" }))).status,
    ).toBe(400);
    await targets.setNodeAccess("node2", { enabled: false, sourceAddress: "192.168.1.20" });
    expect(
      await refusal(() =>
        service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "a" }),
      ),
    ).toEqual({ status: 409, message: "no node of the new list has access enabled with a source address" });
  });

  test("approve runs the action then status and ends the grant with done", async () => {
    const { service, grants, runner, audit } = await maintenanceSetup();
    const grant = service.requestMaintenance({
      targetId: "nas",
      action: "sources",
      toNodes: ["node1", "node2"],
      by: "kir",
    });
    expect(grant.maintenance).toMatchObject({
      action: "sources",
      fromNodes: ["node1"],
      toNodes: ["node1", "node2"],
      fromSources: ["192.168.1.10"],
      toSources: ["192.168.1.10", "192.168.1.20"],
    });
    runner.setPresent(true, "192.168.1.10");
    const done = await service.approve(grant.id, "admin", unlock);
    expect(runner.commands()).toEqual(["sources 192.168.1.10,192.168.1.20", "status"]);
    expect(runner.calls.every((call) => call.config === CONFIG && call.targetId === "nas")).toBe(true);
    expect(runner.calls.every((call) => call.timeoutMs === 15_000)).toBe(true);
    expect(done).toMatchObject({ state: "ended", endReason: "done", maintenance: { result: "done" } });
    expect(grants.get(grant.id)?.state).toBe("ended");
    expect(service.maintenanceFor("nas")).toBeUndefined();
    const lines = audit.filter((line) => line.startsWith("audit ssh maintenance"));
    expect(lines).toContain(
      `audit ssh maintenance grant=${grant.id} target=nas action=sources event=requested by=kir from=1 to=2`,
    );
    expect(lines.some((line) => line.endsWith("event=run command=sources code=0 answer=sources"))).toBe(true);
    // No address goes into an audit line.
    expect(audit.join("\n")).not.toContain("192.168.1.20");
  });

  test("install sends the stored sources before on", async () => {
    const { service, runner } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    const done = await service.approve(grant.id, "admin", unlock);
    expect(runner.commands()).toEqual(["sources 192.168.1.10", "on", "status"]);
    expect(done.maintenance?.result).toBe("done");
  });

  test("uninstall runs uninstall only", async () => {
    const { service, runner } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await service.approve(grant.id, "admin", unlock);
    expect(runner.commands()).toEqual(["uninstall"]);
  });

  test("a grant that expires during the run records failed, skips the next run and does not call finish", async () => {
    const box: { timers?: ReturnType<typeof fakeTimers> } = {};
    const runner = fakeRunner({
      on: async () => {
        // The minute of the grant passes while the command runs.
        await box.timers?.advance(61_000);
        return { code: 0, stdout: "ok on 192.168.1.10\n" };
      },
    });
    const setupResult = await maintenanceSetup({ runner });
    box.timers = setupResult.timers;
    const { service, grants } = setupResult;
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    const finish = spyOn(grants, "finish");
    const result = await service.approve(grant.id, "admin", unlock);
    expect(runner.commands()).toEqual(["sources 192.168.1.10", "on"]);
    expect(result).toMatchObject({ state: "ended", endReason: "expired", maintenance: { result: "failed" } });
    // The sources step had finished: the target holds the list, and the result says so.
    expect(result.maintenance?.detail).toBe(
      "the target already holds part of the change. the grant ended before the run was over",
    );
    expect(result.maintenance?.changed).toBe(true);
    expect(finish).not.toHaveBeenCalled();
    expect(service.maintenanceFor("nas")).toBeUndefined();
  });

  test("approve refuses with 409 when the sources changed since the request", async () => {
    const { service, targets, grants, runner, opened } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    await targets.setNodeAccess("node2", { enabled: true, sourceAddress: "192.168.1.21" });
    expect(await refusal(() => service.approve(grant.id, "admin", unlock))).toEqual({
      status: 409,
      message: "the change is out of date: start it again",
    });
    expect(opened).toEqual([]);
    expect(runner.calls).toHaveLength(0);
    expect(grants.get(grant.id)?.state).toBe("ended");
    expect(service.maintenanceFor("nas")).toBeUndefined();
  });

  test("approve records failed and ends the grant when the runner exits 4", async () => {
    const runner = fakeRunner({
      sources: (command) =>
        command === "sources 192.168.1.20"
          ? { code: 4, stderr: "error guard the new key file failed the check, nothing was written\n" }
          : { code: 0, stdout: `ok ${command}\n` },
    });
    const { service, grants, audit } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result).toMatchObject({ state: "ended", endReason: "done", maintenance: { result: "failed" } });
    expect(result.maintenance?.detail).toContain("guard");
    // The old list goes back in the same grant, and no status runs after a failure.
    expect(runner.commands()).toEqual(["sources 192.168.1.20", "sources 192.168.1.10"]);
    expect(audit.some((line) => line.endsWith("event=restored"))).toBe(true);
    expect(grants.get(grant.id)?.state).toBe("ended");
  });

  test("a runner answer that does not parse is a failure", async () => {
    const runner = fakeRunner({ uninstall: { code: 0, stdout: "removed\n" } });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    // The uninstall may have run before the answer went wrong, so the target counts as changed.
    expect(result.maintenance).toMatchObject({
      result: "failed",
      changed: true,
      detail: "the target already holds part of the change. the script gave no valid answer",
    });
  });

  test("a status that does not show the new list is a failure", async () => {
    const runner = fakeRunner({ status: { code: 0, stdout: "ok status absent 192.168.1.20\n" } });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance?.result).toBe("failed");
  });

  test("a runner that throws still ends the grant", async () => {
    const runner = fakeRunner({
      uninstall: () => {
        throw new Error("boom");
      },
    });
    const { service, grants } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance?.result).toBe("failed");
    expect(grants.get(grant.id)?.state).toBe("ended");
  });

  test("a local node that does not take the grant records failed and clears the lock", async () => {
    const local = fakeNode({ "POST /api/ssh/grants": { status: 500, body: { error: "disk full" } } });
    const { service, grants, runner } = await maintenanceSetup({ local });
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    expect((await refusal(() => service.approve(grant.id, "admin", unlock))).status).toBe(409);
    expect(grants.get(grant.id)).toMatchObject({
      state: "ended",
      endReason: "node-lost",
      maintenance: { result: "failed" },
    });
    expect(runner.calls).toHaveLength(0);
    expect(service.maintenanceFor("nas")).toBeUndefined();
  });

  test("a wrong unlock leaves the maintenance grant pending", async () => {
    const { service, grants } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    expect((await refusal(() => service.approve(grant.id, "admin", wrong))).status).toBe(403);
    expect(grants.get(grant.id)?.state).toBe("pending");
  });

  test("the lock clears on deny, on expiry and after the run", async () => {
    const { service, grants, timers } = await maintenanceSetup();
    const first = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    expect(service.maintenanceFor("nas")?.id).toBe(first.id);
    grants.deny(first.id, "admin");
    expect(service.maintenanceFor("nas")).toBeUndefined();
    const second = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await timers.advance(10 * 60_000 + 1);
    expect(grants.get(second.id)?.state).toBe("ended");
    expect(service.maintenanceFor("nas")).toBeUndefined();
    const third = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await service.approve(third.id, "admin", unlock);
    expect(service.maintenanceFor("nas")).toBeUndefined();
    service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
  });

  test("the lock holds while a run goes on after its grant ended", async () => {
    const gate: { open?: () => void } = {};
    const runner = fakeRunner({
      uninstall: () =>
        new Promise((resolve) => {
          gate.open = () => {
            resolve({ code: 0, stdout: "ok uninstall\n" });
          };
        }),
    });
    const { service, grants } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    const run = service.approve(grant.id, "admin", unlock);
    await until(() => gate.open !== undefined);
    grants.revoke(grant.id, "admin");
    expect(service.maintenanceFor("nas")?.id).toBe(grant.id);
    expect(
      (await refusal(() => service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "a" }))).status,
    ).toBe(409);
    gate.open?.();
    expect((await run).maintenance?.result).toBe("done");
    expect(service.maintenanceFor("nas")).toBeUndefined();
  });
});

describe("SshService maintenance commit, changed and the sign cap", () => {
  const blobOf = (keys: SshKeyStore) =>
    new Uint8Array(Buffer.from(keys.publicLine("nas", "provisioner").split(" ")[1] ?? "", "base64"));

  /** Each run signs once through the grant store, as ssh does through the agent of the grant. */
  function signingRunner(
    box: { grants?: GrantStore; keys?: SshKeyStore; signed: number },
    inner: ReturnType<typeof fakeRunner>,
  ): ReturnType<typeof fakeRunner> {
    const runner: SshRunner = (...args) => {
      const grants = box.grants;
      const keys = box.keys;
      if (!grants || !keys) throw new Error("not set up");
      const active = grants.list().find((grant) => grant.maintenance && grant.state === "active");
      if (!active) return Promise.resolve({ code: 255, stdout: "", stderr: "agent refused operation\n" });

      try {
        grants.sign(active.id, blobOf(keys), new Uint8Array([1, 2, 3]));
        box.signed++;
      } catch {
        return Promise.resolve({ code: 255, stdout: "", stderr: "agent refused operation\n" });
      }

      return inner.runner(...args);
    };

    return { ...inner, runner };
  }

  async function signingSetup(replies: Parameters<typeof fakeRunner>[0] = {}) {
    const box: { grants?: GrantStore; keys?: SshKeyStore; signed: number } = { signed: 0 };
    const inner = fakeRunner(replies);
    // The main line is on the target with the old list.
    inner.setPresent(true, "192.168.1.10");
    const made = await maintenanceSetup({ runner: signingRunner(box, inner) });
    box.grants = made.grants;
    box.keys = made.keys;
    return { ...made, inner, box };
  }

  test("a good run and a commit that fails: the old list goes back in the same grant and the error comes out", async () => {
    const { service, grants, inner, box, audit } = await signingSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    const states: (string | undefined)[] = [];
    const failure = await rejection(
      service.approve(grant.id, "admin", unlock, undefined, {
        commit: (current) => {
          states.push(grants.get(current.id)?.state);
          return Promise.reject(new Error("setNodes failed"));
        },
      }),
    );
    expect(failure.message).toBe("setNodes failed");
    expect(states).toEqual(["active"]);
    expect(inner.commands()).toEqual(["sources 192.168.1.20", "status", "sources 192.168.1.10"]);
    expect(box.signed).toBe(3);
    expect(grants.get(grant.id)).toMatchObject({
      state: "ended",
      endReason: "done",
      maintenance: { result: "failed", changed: false, detail: "the change was not stored: setNodes failed" },
    });
    expect(audit.some((line) => line.endsWith("event=restored"))).toBe(true);
    expect(service.maintenanceFor("nas")).toBeUndefined();
  });

  test("a commit that works: no restore, and the grant ends with done", async () => {
    const { service, grants, inner } = await signingSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    let commits = 0;
    const done = await service.approve(grant.id, "admin", unlock, undefined, {
      commit: () => {
        commits++;
        return Promise.resolve();
      },
    });
    expect(commits).toBe(1);
    expect(inner.commands()).toEqual(["sources 192.168.1.20", "status"]);
    expect(done).toMatchObject({ state: "ended", endReason: "done", maintenance: { result: "done", changed: true } });
    expect(grants.get(grant.id)?.state).toBe("ended");
  });

  test("no commit after a failed run", async () => {
    const { service } = await signingSetup({ status: { code: 0, stdout: "ok status absent 192.168.1.20\n" } });
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    let commits = 0;
    const result = await service.approve(grant.id, "admin", unlock, undefined, {
      commit: () => {
        commits++;
        return Promise.resolve();
      },
    });
    expect(commits).toBe(0);
    expect(result.maintenance).toMatchObject({ result: "failed", changed: false });
  });

  test("a restore that fails is audited with a fixed word and the code, and the text stays in the detail", async () => {
    const { service, grants, audit } = await signingSetup({
      sources: (command) =>
        command === "sources 192.168.1.10"
          ? { code: 255, stderr: "ssh: connect to host 10.0.0.5 port 22: Connection refused\n" }
          : { code: 0, stdout: `ok ${command}\n` },
      status: { code: 0, stdout: "ok status present 192.168.1.20\n" },
    });
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    const failure = await rejection(
      service.approve(grant.id, "admin", unlock, undefined, { commit: () => Promise.reject(new Error("disk full")) }),
    );
    expect(failure.message).toBe("disk full");
    const work = grants.get(grant.id)?.maintenance;
    expect(work).toMatchObject({ result: "failed", changed: true });
    expect(
      work?.detail?.startsWith("the target already holds part of the change. the old list could not be put back"),
    ).toBe(true);
    expect(work?.detail).toContain("10.0.0.5");
    const failed = audit.filter((line) => line.includes("event=restore-failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/ event=restore-failed code=255$/);
    expect(audit.join("\n")).not.toContain("10.0.0.5");
    expect(grants.get(grant.id)?.state).toBe("ended");
  });

  test("a commit that fails on uninstall says that the target changed", async () => {
    const { service, grants } = await signingSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await rejection(
      service.approve(grant.id, "admin", unlock, undefined, { commit: () => Promise.reject(new Error("no")) }),
    );
    expect(grants.get(grant.id)?.maintenance).toMatchObject({ result: "failed", changed: true });
  });

  test("sources works, then the grant ends before status: failed with changed", async () => {
    const box: { grants?: GrantStore } = {};
    const runner = fakeRunner({
      sources: (command) => {
        const active = box.grants?.list().find((grant) => grant.maintenance && grant.state === "active");
        if (active) box.grants?.revoke(active.id, "admin");
        return { code: 0, stdout: `ok ${command}\n` };
      },
    });
    const made = await maintenanceSetup({ runner });
    box.grants = made.grants;
    const grant = made.service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "a" });
    const result = await made.service.approve(grant.id, "admin", unlock);
    expect(runner.commands()).toEqual(["sources 192.168.1.20"]);
    expect(result).toMatchObject({
      state: "ended",
      endReason: "revoked",
      maintenance: { result: "failed", changed: true },
    });
    expect(result.maintenance?.detail?.startsWith("the target already holds part of the change")).toBe(true);
  });

  test("a failure before any changing step has changed false", async () => {
    const runner = fakeRunner({ sources: { code: 4, stderr: "error guard nothing was written\n" } });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance).toMatchObject({ result: "failed", changed: false });
    expect(result.maintenance?.detail).toContain("guard");
  });

  test("a changing step that times out counts as changed when the restore fails too", async () => {
    const runner = fakeRunner({ sources: { code: 124, stderr: "ssh: timed out" } });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    // The script may have written the line before the time ran out.
    expect(runner.commands()).toEqual(["sources 192.168.1.20", "sources 192.168.1.10"]);
    expect(result.maintenance).toMatchObject({ result: "failed", changed: true });
    expect(result.maintenance?.detail?.startsWith("the target already holds part of the change")).toBe(true);
  });

  test("a changing step with an answer that does not parse counts as changed", async () => {
    const runner = fakeRunner({ uninstall: { code: 0, stdout: "garbage\n" } });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance).toMatchObject({ result: "failed", changed: true });
  });

  test("a changing step that times out is not changed when the restore works", async () => {
    const runner = fakeRunner({
      sources: (command) =>
        command === "sources 192.168.1.20"
          ? { code: 124, stderr: "ssh: timed out" }
          : { code: 0, stdout: `ok ${command}\n` },
    });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance).toMatchObject({ result: "failed", changed: false });
  });

  test("a script refusal on a changing step wrote nothing and is not changed", async () => {
    const runner = fakeRunner({ uninstall: { code: 3, stderr: "error unsafe-file the key file is a link\n" } });
    const { service } = await maintenanceSetup({ runner });
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance).toMatchObject({ result: "failed", changed: false });
  });

  test("a commit that hangs fails after the time limit, restores in the same grant and says so", async () => {
    const { service, grants, inner, timers, audit } = await (async () => {
      const inner = fakeRunner();
      inner.setPresent(true, "192.168.1.10");
      const made = await maintenanceSetup({ runner: inner, commitTimeoutMs: 5_000 });
      return { ...made, inner };
    })();
    const grant = service.requestMaintenance({ targetId: "nas", action: "sources", toNodes: ["node2"], by: "admin" });
    let signal: AbortSignal | undefined;
    const pending = service.approve(grant.id, "admin", unlock, undefined, {
      commit: (_current, given) => {
        signal = given;
        return new Promise<void>(() => {});
      },
    });
    await until(() => signal !== undefined);
    expect(service.maintenanceFor("nas")?.id).toBe(grant.id);
    const caught = rejection(pending);
    await timers.advance(5_000);
    const failure = await caught;
    expect(failure.message).toBe("the change could not be stored in time");
    expect(signal?.aborted).toBe(true);
    expect(inner.commands()).toEqual(["sources 192.168.1.20", "status", "sources 192.168.1.10"]);
    expect(grants.get(grant.id)).toMatchObject({
      state: "ended",
      endReason: "done",
      maintenance: {
        result: "failed",
        changed: false,
        detail: "the change was not stored: the change could not be stored in time",
      },
    });
    expect(service.maintenanceFor("nas")).toBeUndefined();
    expect(audit.some((line) => line.includes(" event=commit-failed "))).toBe(true);
  });

  test("a commit that works writes the committed audit line", async () => {
    const { service, audit } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "install", by: "admin" });
    await service.approve(grant.id, "admin", unlock, undefined, { commit: () => Promise.resolve() });
    expect(audit.some((line) => line.endsWith(" event=committed"))).toBe(true);
  });

  test("an uninstall is not out of date when an address of a node changed", async () => {
    const { service, targets } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await targets.setNodeAccess("node1", { enabled: true, sourceAddress: "192.168.1.99" });
    const result = await service.approve(grant.id, "admin", unlock);
    expect(result.maintenance).toMatchObject({ result: "done" });
  });

  test("the grant gives no more signatures than its planned runs", async () => {
    const { service, grants, keys, audit } = await signingSetup();
    const extra: string[] = [];
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await service.approve(grant.id, "admin", unlock, undefined, {
      commit: () => {
        // A root process on the hub that reaches the socket asks the agent once more while the grant is active.
        try {
          grants.sign(grant.id, blobOf(keys), new Uint8Array([4]));
        } catch (error) {
          extra.push(error instanceof GrantError ? `${error.status} ${error.message}` : "other");
        }

        return Promise.resolve();
      },
    });
    expect(extra).toEqual(["403 the grant has no run left"]);
    expect(
      audit.filter((line) => line.includes(" event=sign-refused ") && line.endsWith(" reason=run-cap")),
    ).toHaveLength(1);
  });

  test("a pending maintenance grant whose target went away ends at approve", async () => {
    const { service, targets, grants } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    await targets.remove("nas");
    expect((await refusal(() => service.approve(grant.id, "admin", unlock))).status).toBe(404);
    expect(grants.get(grant.id)?.state).toBe("ended");
    expect(service.maintenanceFor("nas")).toBeUndefined();
  });

  test("a finish that throws still ends the grant with done, not revoked", async () => {
    const { service, grants } = await maintenanceSetup();
    const grant = service.requestMaintenance({ targetId: "nas", action: "uninstall", by: "admin" });
    spyOn(grants, "finish").mockImplementation(() => {
      throw new Error("boom");
    });
    await service.approve(grant.id, "admin", unlock);
    expect(grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "done", maintenance: { result: "done" } });
  });
});

async function until(check: () => boolean): Promise<void> {
  // The derive of the passphrase takes real time.
  for (let round = 0; round < 500; round++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("timed out");
}
