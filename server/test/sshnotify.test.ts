import { describe, expect, test } from "bun:test";
import type { Grant } from "../src/sshgrants";
import { closeMessage, createRequestNotifier, requestMessage } from "../src/sshnotify";
import type { PushMessage } from "../src/webpush";
import type { Target } from "../src/sshtargets";

const target = {
  id: "nas",
  address: "10.0.0.5",
  port: 2222,
  account: "root",
  systemType: "linux",
  nodes: ["node1"],
  hostKey: "ssh-ed25519 AAAA",
  state: "ready",
} as Target;

const grant = (extra: Partial<Grant> = {}): Grant => ({
  id: "g1",
  nodeId: "node1",
  instanceId: "inst1",
  targetId: "nas",
  minutes: 30,
  test: false,
  state: "pending",
  requestedAt: 1,
  ...extra,
});

describe("requestMessage", () => {
  test("names target, instance, minutes and reason", () => {
    expect(requestMessage(grant({ reason: "deploy" }), target, "work")).toEqual({
      title: "SSH access requested",
      body: "nas on work, 30 min: deploy",
      url: "/ssh",
      tag: "ssh-g1",
      grantId: "g1",
    });
  });

  test("cuts a 5000 character reason to 120", () => {
    const { body } = requestMessage(grant({ reason: "x".repeat(5000) }), target, "work");
    expect(body).toBe(`nas on work, 30 min: ${"x".repeat(120)}`);
  });

  test("replaces newlines and control characters", () => {
    const { body } = requestMessage(grant({ reason: "a\nb\r\nc\u0007d\te" }), target, "work");
    expect(body).toBe("nas on work, 30 min: a b  c d e");
  });

  test("holds no secret field", () => {
    const message = requestMessage(grant({ reason: "r" }), target, "work");
    expect(Object.keys(message).sort()).toEqual(["body", "grantId", "tag", "title", "url"]);
    const json = JSON.stringify(message);
    expect(json).not.toContain("10.0.0.5");
    expect(json).not.toContain("ssh-ed25519");
  });
});

describe("createRequestNotifier", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  function run(listInstances: (nodeId: string) => Promise<{ id: string; name: string }[]> | undefined, timeoutMs = 20) {
    const sent: PushMessage[] = [];
    const errors: string[] = [];
    const notify = createRequestNotifier({
      send: (message) => sent.push(message),
      listInstances,
      timeoutMs,
      onError: (text) => errors.push(text),
    });
    notify(grant({ instanceId: "inst1" }), target);
    return { sent, errors, settle };
  }

  test("names the instance when the lookup finds it", async () => {
    const { sent } = run(async () => [{ id: "inst1", name: "work" }]);
    await settle();
    expect(sent.map((m) => m.body)).toEqual(["nas on work, 30 min"]);
  });

  test("falls back to the id when the lookup fails", async () => {
    const { sent, errors } = run(() => Promise.reject(new Error("down")));
    await settle();
    expect(sent.map((m) => m.body)).toEqual(["nas on inst1, 30 min"]);
    expect(errors).toEqual(["down"]);
  });

  test("falls back to the id when the lookup times out", async () => {
    const { sent } = run(() => new Promise(() => {}));
    await settle();
    expect(sent.map((m) => m.body)).toEqual(["nas on inst1, 30 min"]);
  });

  test("falls back to the id when the instance is not found or the node is unknown", async () => {
    const other = run(async () => [{ id: "other", name: "x" }]);
    const unknown = run(() => undefined);
    await settle();
    expect(other.sent.map((m) => m.body)).toEqual(["nas on inst1, 30 min"]);
    expect(unknown.sent.map((m) => m.body)).toEqual(["nas on inst1, 30 min"]);
  });
});

describe("closeMessage", () => {
  test("holds only the tag, the grant id, the close flag and fixed text", () => {
    const message = closeMessage(grant({ reason: "secret reason reboot" }));
    expect(message).toEqual({
      title: "SSH request answered",
      body: "",
      url: "/ssh",
      tag: "ssh-g1",
      grantId: "g1",
      close: true,
    });
    expect(JSON.stringify(message)).not.toContain("nas");
    expect(JSON.stringify(message)).not.toContain("secret");
  });
});

describe("createRequestNotifier with a grant that is answered during the lookup", () => {
  test("a slow lookup and a deny in between send only the close push", async () => {
    const sent: PushMessage[] = [];
    let pending = true;
    let release: (list: { id: string; name: string }[]) => void = () => {};
    const notify = createRequestNotifier({
      send: (message) => sent.push(message),
      isPending: () => pending,
      listInstances: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    notify(grant(), target);
    pending = false;
    sent.push(closeMessage(grant()));
    release([{ id: "inst1", name: "work" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.map((m) => m.close === true)).toEqual([true]);
  });
});
