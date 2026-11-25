import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { HostError } from "../src/hostclient";
import type { HostClient } from "../src/hostclient";
import { GrantError, GrantStore } from "../src/sshgrants";
import type { Grant } from "../src/sshgrants";
import { SshKeyStore } from "../src/sshkeystore";
import type { UnlockSecret } from "../src/sshkeystore";
import { NodeError, SshService } from "../src/sshservice";
import { TargetError, TargetStore } from "../src/sshtargets";
import type { Target } from "../src/sshtargets";
import { newRecovery } from "../src/sshwrap";
import { fakeTimers } from "./faketimers";

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
    expect(sent[0]![0].id).toBe(grant!.id);
    expect(sent[0]![1].id).toBe("nas");
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
    await ctx.service.approve(grant!.id, "alice", unlock);
    expect(closed.map((item) => item.id)).toEqual([grant!.id]);
    ctx.grants.revoke(grant!.id, "alice");
    expect(closed).toHaveLength(1);
  });

  test("a denied request sends one close", async () => {
    const closed: Grant[] = [];
    const ctx = await setup({ notifyClose: (grant) => closed.push(grant) });
    ctx.service.onNodeEvent("node1", "ssh.request", request({ minutes: 30 }));
    await flush();
    const [grant] = ctx.grants.list();
    ctx.grants.deny(grant!.id, "alice");
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
