import { describe, expect, test } from "bun:test";
import type { Grant } from "../../../src/ssh/hub/GrantStore";
import {
  closeMessage,
  createMaintenanceNotifier,
  createRequestNotifier,
  maintenanceMessage,
  requestMessage,
} from "../../../src/ssh/hub/notify";
import type { PushMessage } from "../../../src/push/PushService";
import type { Target } from "../../../src/ssh/TargetStore";

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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  function run(listInstances: (nodeId: string) => Promise<{ id: string; name: string }[]> | undefined, timeoutMs = 50) {
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

describe("plain text", () => {
  test("bidi and zero-width characters become spaces", () => {
    const text = requestMessage(grant({ reason: "a\u202eb\u200bc\u2066d" }), target, "work").body;
    expect(text).toContain(": a b c d");
  });

  test("the cut never splits a surrogate pair", () => {
    const text = requestMessage(grant({ reason: "\u{1F600}".repeat(130) }), target, "work").body;
    const reason = text.split(": ")[1]!;
    expect(Array.from(reason)).toHaveLength(120);
    expect(reason).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
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

describe("maintenanceMessage", () => {
  const work = (action: "install" | "sources" | "uninstall") =>
    grant({
      nodeId: "local",
      instanceId: "maintenance",
      reason: "secret reason",
      maintenance: {
        action,
        fromNodes: ["node1"],
        toNodes: ["node9"],
        fromSources: ["192.168.1.10"],
        toSources: ["192.168.9.9"],
      },
    });

  test("maintenanceMessage names the target and the action", () => {
    expect(maintenanceMessage(work("sources"), target)).toEqual({
      title: "SSH maintenance requested",
      body: "nas: change of nodes",
      url: "/ssh",
      tag: "ssh-g1",
      grantId: "g1",
    });
    expect(maintenanceMessage(work("uninstall"), target).body).toBe("nas: remove the key lines (retire)");
    expect(maintenanceMessage(work("install"), target).body).toBe("nas: put the key line back");
  });

  test("maintenanceMessage holds no address and no node id", () => {
    const text = JSON.stringify(maintenanceMessage(work("sources"), target));
    for (const bad of ["10.0.0.5", "192.168", "node1", "node9", "secret reason", "AAAA"])
      expect(text).not.toContain(bad);
  });

  test("the maintenance notifier sends once and skips a grant that is not pending", () => {
    const sent: PushMessage[] = [];
    createMaintenanceNotifier({ send: (message) => sent.push(message) })(work("install"), target);
    expect(sent).toHaveLength(1);
    createMaintenanceNotifier({ send: (message) => sent.push(message), isPending: () => false })(
      work("install"),
      target,
    );
    expect(sent).toHaveLength(1);
  });

  test("the maintenance body has no control characters, and a failed send goes to onError", async () => {
    const odd = { ...target, id: "na\ns\u202e" } as Target;
    expect(maintenanceMessage(work("install"), odd).body).toBe("na s : put the key line back");
    const errors: string[] = [];
    createMaintenanceNotifier({
      send: () => Promise.reject(new Error("push down")),
      onError: (text) => errors.push(text),
    })(work("install"), target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(errors).toEqual(["push down"]);
    createMaintenanceNotifier({
      send: () => {
        throw new Error("sync boom");
      },
      onError: (text) => errors.push(text),
    })(work("install"), target);
    expect(errors).toEqual(["push down", "sync boom"]);
  });
});
