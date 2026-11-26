import { describe, expect, test } from "bun:test";
import { GrantError, GrantStore } from "../src/sshgrants";
import type { Grant } from "../src/sshgrants";
import type { UnlockedKey } from "../src/sshkeystore";
import { fakeTimers } from "./faketimers";

function fakeKey(tag = "a") {
  const calls = { sign: 0, destroy: 0 };
  const key: UnlockedKey = {
    fingerprint: `SHA256:fp-${tag}`,
    publicBlob: new Uint8Array([1, 2, 3, tag.charCodeAt(0)]),
    sign: () => {
      calls.sign++;
      return new Uint8Array([9, 9]);
    },
    destroy: () => {
      calls.destroy++;
    },
  };
  return { key, calls };
}

function setup(extra: { defaultMinutes?: number; maxMinutes?: number; pendingMinutes?: number } = {}) {
  const timers = fakeTimers(1_000_000);
  const audit: string[] = [];
  const ended: Grant[] = [];
  const store = new GrantStore({
    now: () => timers.now(),
    timers,
    audit: (line) => audit.push(line),
    onEnd: (grant) => ended.push(grant),
    ...extra,
  });
  const input = { nodeId: "node1", instanceId: "inst1", targetId: "nas" };
  return { timers, audit, ended, store, input };
}

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof GrantError ? error.status : -1;
  }

  return undefined;
};

describe("GrantStore", () => {
  test("request gives a pending grant with the default 60 minutes", () => {
    const { store, input } = setup();
    const grant = store.request(input);
    expect(grant.state).toBe("pending");
    expect(grant.minutes).toBe(60);
    expect(grant.test).toBe(false);
    expect(grant.requestedAt).toBe(1_000_000);
    expect(store.get(grant.id)?.id).toBe(grant.id);
    expect(store.list()).toHaveLength(1);
  });

  test("request clamps minutes to 480", () => {
    const { store, input } = setup();
    expect(store.request({ ...input, minutes: 9999 }).minutes).toBe(480);
    expect(store.request({ ...input, minutes: 30 }).minutes).toBe(30);
    expect(status(() => store.request({ ...input, minutes: 0 }))).toBe(400);
    expect(status(() => store.request({ ...input, minutes: Number.NaN }))).toBe(400);
  });

  test("a test grant is 1 minute", () => {
    const { store, input } = setup();
    const grant = store.request({ ...input, minutes: 200, test: true });
    expect(grant.test).toBe(true);
    expect(grant.minutes).toBe(1);
  });

  test("approve makes the grant active with an end time", () => {
    const { store, input } = setup();
    const grant = store.request({ ...input, minutes: 10 });
    const { key } = fakeKey();
    const active = store.approve(grant.id, "alice", key);
    expect(active.state).toBe("active");
    expect(active.approvedBy).toBe("alice");
    expect(active.approvedAt).toBe(1_000_000);
    expect(active.endsAt).toBe(1_000_000 + 10 * 60_000);
    expect(store.approve(store.request(input).id, "alice", fakeKey("b").key, 5).minutes).toBe(5);
  });

  test("a second approve throws 409 and keeps one active grant", () => {
    const { store, input } = setup();
    const grant = store.request(input);
    const first = fakeKey("a");
    const second = fakeKey("b");
    store.approve(grant.id, "alice", first.key);
    expect(status(() => store.approve(grant.id, "bob", second.key))).toBe(409);
    expect(first.calls.destroy).toBe(0);
    expect(second.calls.destroy).toBe(1);
    expect(store.list().filter((item) => item.state === "active")).toHaveLength(1);
    expect(store.get(grant.id)?.approvedBy).toBe("alice");
    expect(status(() => store.approve("nope", "alice", fakeKey().key))).toBe(404);
  });

  test("sign on a pending grant throws 403", () => {
    const { store, input } = setup();
    const grant = store.request(input);
    const { key, calls } = fakeKey();
    expect(status(() => store.sign(grant.id, key.publicBlob, new Uint8Array([1])))).toBe(403);
    expect(calls.sign).toBe(0);
    expect(status(() => store.sign("nope", key.publicBlob, new Uint8Array([1])))).toBe(404);
  });

  test("sign with another key blob throws 403", () => {
    const { store, input } = setup();
    const grant = store.request(input);
    const { key, calls } = fakeKey();
    store.approve(grant.id, "alice", key);
    expect(status(() => store.sign(grant.id, new Uint8Array([7, 7]), new Uint8Array([1])))).toBe(403);
    expect(calls.sign).toBe(0);
    expect(store.sign(grant.id, key.publicBlob, new Uint8Array([1]))).toEqual(new Uint8Array([9, 9]));
    expect(calls.sign).toBe(1);
  });

  test("sign after the end time throws 403 and the key is destroyed", async () => {
    const { store, input, timers, ended } = setup();
    const grant = store.request({ ...input, minutes: 1 });
    const { key, calls } = fakeKey();
    store.approve(grant.id, "alice", key);
    await timers.advance(60_000);
    expect(status(() => store.sign(grant.id, key.publicBlob, new Uint8Array([1])))).toBe(403);
    expect(calls.sign).toBe(0);
    expect(calls.destroy).toBe(1);
    expect(store.get(grant.id)?.state).toBe("ended");
    expect(store.get(grant.id)?.endReason).toBe("expired");
    expect(ended).toHaveLength(1);
  });

  test("revoke ends the grant and destroys the key", () => {
    const { store, input, ended, timers } = setup();
    const grant = store.request(input);
    const { key, calls } = fakeKey();
    store.approve(grant.id, "alice", key);
    const done = store.revoke(grant.id, "alice");
    expect(done.state).toBe("ended");
    expect(done.endReason).toBe("revoked");
    expect(calls.destroy).toBe(1);
    expect(ended.map((item) => item.id)).toEqual([grant.id]);
    expect(timers.pending()).toBe(0);
    expect(status(() => store.revoke(grant.id, "alice"))).toBe(409);
    expect(status(() => store.sign(grant.id, key.publicBlob, new Uint8Array([1])))).toBe(403);
  });

  test("endWhere ends every matching active grant", () => {
    const { store, input, ended } = setup();
    const keys = [fakeKey("a"), fakeKey("b"), fakeKey("c")];
    const grants = [
      store.request(input),
      store.request({ ...input, nodeId: "node2" }),
      store.request({ ...input, nodeId: "node1" }),
    ];
    grants.forEach((grant, index) => store.approve(grant.id, "alice", keys[index].key));
    const pending = store.request(input);
    const result = store.endWhere((item) => item.nodeId === "node1", "node-lost");
    expect(result.map((item) => item.id).sort()).toEqual([grants[0].id, grants[2].id, pending.id].sort());
    expect(keys[0].calls.destroy).toBe(1);
    expect(keys[1].calls.destroy).toBe(0);
    expect(keys[2].calls.destroy).toBe(1);
    expect(store.get(grants[0].id)?.endReason).toBe("node-lost");
    expect(store.get(grants[1].id)?.state).toBe("active");
    expect(store.get(pending.id)?.state).toBe("ended");
    expect(ended).toHaveLength(3);
  });

  test("deny ends a pending grant with reason denied", () => {
    const { store, input, ended, timers } = setup();
    const grant = store.request(input);
    const done = store.deny(grant.id, "alice");
    expect(done.state).toBe("ended");
    expect(done.endReason).toBe("denied");
    expect(ended).toHaveLength(1);
    expect(timers.pending()).toBe(0);
    expect(status(() => store.deny(grant.id, "alice"))).toBe(409);
    expect(status(() => store.approve(grant.id, "alice", fakeKey().key))).toBe(409);
  });

  test("a pending grant expires after 10 minutes with reason expired and onEnd runs", async () => {
    const { store, input, ended, timers } = setup();
    const grant = store.request(input);
    await timers.advance(9 * 60_000);
    expect(store.get(grant.id)?.state).toBe("pending");
    await timers.advance(60_000);
    expect(store.get(grant.id)?.state).toBe("ended");
    expect(store.get(grant.id)?.endReason).toBe("expired");
    expect(ended).toHaveLength(1);
  });

  test("every transition writes one audit line", () => {
    const { store, input, audit } = setup();
    const first = store.request(input);
    expect(audit).toHaveLength(1);
    store.approve(first.id, "alice", fakeKey().key);
    expect(audit).toHaveLength(2);
    store.revoke(first.id, "bob");
    expect(audit).toHaveLength(3);
    const second = store.request(input);
    store.deny(second.id, "alice");
    expect(audit).toHaveLength(5);
    expect(audit[0]).toBe(`audit ssh grant=${first.id} event=requested node=node1 target=nas by=node1`);
    expect(audit[1]).toBe(`audit ssh grant=${first.id} event=approved node=node1 target=nas by=alice`);
    expect(audit[2]).toBe(`audit ssh grant=${first.id} event=revoked node=node1 target=nas by=bob`);
    expect(audit[4]).toBe(`audit ssh grant=${second.id} event=denied node=node1 target=nas by=alice`);
  });

  test("audit values from users cannot add a field or a line", () => {
    const { store, audit } = setup();
    const grant = store.request({ nodeId: "n1", instanceId: "i", targetId: "nas" });
    store.approve(grant.id, "evil by=root\nforged", fakeKey().key);
    expect(audit[1]).not.toContain("\n");
    expect(audit[1]).toContain('by="evil by=root\\nforged"');
  });

  test("an audit line for a sign holds the key fingerprint and no data", () => {
    const { store, input, audit } = setup();
    const grant = store.request(input);
    const { key } = fakeKey();
    store.approve(grant.id, "alice", key);
    store.sign(grant.id, key.publicBlob, new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]));
    const line = audit[audit.length - 1];
    expect(line).toBe(`audit ssh grant=${grant.id} event=signed node=node1 target=nas by=node1 key=SHA256:fp-a`);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("736563726574");
  });

  describe("onLeavePending", () => {
    function withHook() {
      const timers = fakeTimers(1_000_000);
      const left: Grant[] = [];
      const store = new GrantStore({
        now: () => timers.now(),
        timers,
        audit: () => {},
        onEnd: () => {},
        onLeavePending: (grant) => left.push(grant),
      });
      const input = { nodeId: "node1", instanceId: "inst1", targetId: "nas" };
      return { timers, left, store, input };
    }

    test("approve calls it once, and the end of the active grant does not", () => {
      const { store, input, left } = withHook();
      const grant = store.request(input);
      store.approve(grant.id, "admin", fakeKey().key);
      expect(left.map((item) => item.state)).toEqual(["active"]);
      store.revoke(grant.id, "admin");
      expect(left).toHaveLength(1);
    });

    test("deny, pending expiry and endWhere of a pending grant call it once each", () => {
      const { store, input, left, timers } = withHook();
      const denied = store.request(input);
      store.deny(denied.id, "admin");
      store.request(input);
      timers.advance(11 * 60_000);
      const third = store.request(input);
      store.endWhere((item) => item.id === third.id, "node-lost");
      expect(left.map((item) => item.endReason)).toEqual(["denied", "expired", "node-lost"]);
    });

    test("a throwing hook on deny still runs onEnd", () => {
      const timers = fakeTimers(1_000_000);
      const ended: Grant[] = [];
      const store = new GrantStore({
        timers,
        audit: () => {},
        onEnd: (grant) => ended.push(grant),
        onLeavePending: () => {
          throw new Error("boom");
        },
      });
      const grant = store.request({ nodeId: "n", instanceId: "i", targetId: "t" });
      expect(store.deny(grant.id, "admin").state).toBe("ended");
      expect(ended).toHaveLength(1);
    });

    test("active expiry calls it none, and a throwing hook does not fail approve", () => {
      const { store, input, left, timers } = withHook();
      const grant = store.request(input);
      store.approve(grant.id, "admin", fakeKey().key, 1);
      timers.advance(2 * 60_000);
      expect(left).toHaveLength(1);

      const bad = new GrantStore({
        timers,
        audit: () => {},
        onEnd: () => {},
        onLeavePending: () => {
          throw new Error("boom");
        },
      });
      const next = bad.request(input);
      expect(bad.approve(next.id, "admin", fakeKey().key).state).toBe("active");
    });
  });
});

describe("GrantStore maintenance", () => {
  const maintenance = {
    action: "sources" as const,
    fromNodes: ["a"],
    toNodes: ["b"],
    fromSources: ["10.0.0.1"],
    toSources: ["10.0.0.2"],
  };
  const local = { nodeId: "local", instanceId: "maintenance", targetId: "nas" };

  test("a maintenance grant is 1 minute and ignores minutes at approve", () => {
    const { store } = setup();
    const grant = store.request({ ...local, minutes: 30, maintenance });
    expect(grant.minutes).toBe(1);
    expect(grant.maintenance).toEqual(maintenance);
    const active = store.approve(grant.id, "admin", fakeKey().key, 120);
    expect(active.minutes).toBe(1);
    expect(active.endsAt).toBe(1_000_000 + 60_000);
  });

  test("a grant is never both a test and a maintenance grant", () => {
    const { store } = setup();
    expect(status(() => store.request({ ...local, test: true, maintenance }))).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  test("the projection is a copy: a change to it does not reach the store", () => {
    const { store } = setup();
    const grant = store.request({ ...local, maintenance });
    const work = grant.maintenance;
    if (!work?.toSources) throw new Error("no maintenance");
    work.toSources.push("10.9.9.9");
    work.action = "uninstall";
    expect(store.get(grant.id)?.maintenance).toEqual(maintenance);
  });

  test("setResult records the result on the grant", () => {
    const { store, audit } = setup();
    const grant = store.request({ ...local, maintenance });
    store.setResult(grant.id, "failed", "line one\nline two");
    expect(store.get(grant.id)?.maintenance).toMatchObject({ result: "failed", detail: "line one line two" });
    expect(audit.join("\n")).not.toContain("line one");
    // A plain grant has no result.
    const plain = store.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas" });
    expect(
      status(() => {
        store.setResult(plain.id, "done");
      }),
    ).toBe(409);
    expect(
      status(() => {
        store.setResult("nope", "done");
      }),
    ).toBe(404);
  });

  test("finish ends it with done and destroys the key", () => {
    const { store, ended } = setup();
    const grant = store.request({ ...local, maintenance });
    // A pending grant cannot finish: it never ran.
    expect(status(() => store.finish(grant.id, "admin"))).toBe(409);
    const { key, calls } = fakeKey();
    store.approve(grant.id, "admin", key);
    store.setResult(grant.id, "done");
    const done = store.finish(grant.id, "admin");
    expect(done).toMatchObject({ state: "ended", endReason: "done", maintenance: { result: "done" } });
    expect(calls.destroy).toBe(1);
    expect(ended.map((item) => item.endReason)).toEqual(["done"]);
    expect(status(() => store.finish(grant.id, "admin"))).toBe(409);
    // A plain active grant cannot finish.
    const plain = store.request({ nodeId: "node1", instanceId: "inst1", targetId: "nas" });
    store.approve(plain.id, "admin", fakeKey("b").key);
    expect(status(() => store.finish(plain.id, "admin"))).toBe(409);
  });
});
