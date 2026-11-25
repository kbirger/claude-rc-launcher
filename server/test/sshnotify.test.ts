import { describe, expect, test } from "bun:test";
import type { Grant } from "../src/sshgrants";
import { requestMessage } from "../src/sshnotify";
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
