import { describe, expect, spyOn, test } from "bun:test";
import { GrantStore } from "../src/sshgrants";
import { SshKeyStore } from "../src/sshkeystore";
import type { UnlockSecret } from "../src/sshkeystore";
import { CONFIRM_NODES_SUFFIX, CONFIRM_NODES_TEXT } from "../src/sshprovisioner";
import { NodeError } from "../src/sshservice";
import type { SshService } from "../src/sshservice";
import { TargetLocks } from "../src/sshtargetlocks";
import { TargetError, TargetStore } from "../src/sshtargets";
import { MIN_PASSPHRASE, SshTargetService } from "../src/sshtargetservice";
import { newRecovery } from "../src/sshwrap";

const passphrase = (text: string): UnlockSecret => ({ method: "passphrase", secret: new TextEncoder().encode(text) });
const GOOD = "correct horse battery";

interface FakeOptions {
  /** `authorizeManaged` with a new list throws this. */
  authorizeFails?: Error;
  /** A pending maintenance grant blocks the target. */
  busy?: boolean;
}

async function setup(options: FakeOptions = {}) {
  const keys = new SshKeyStore();
  await keys.setup({ method: "passphrase", recoveryPublicKey: newRecovery().publicKey });
  const targets = new TargetStore();
  const grants = new GrantStore({ audit: () => {}, onEnd: () => {} });
  const authorized: (string[] | undefined)[] = [];
  const requested: unknown[] = [];
  const service = {
    maintenanceFor: () => (options.busy ? { id: "g" } : undefined),
    pushTargets: () => Promise.resolve(),
    authorizeManaged: (_id: string, nodes?: string[]) => {
      authorized.push(nodes);
      return nodes && options.authorizeFails ? Promise.reject(options.authorizeFails) : Promise.resolve();
    },
    requestMaintenance: (input: unknown) => {
      requested.push(input);
      return { id: "g1", targetId: "t1", state: "pending" };
    },
  } as unknown as SshService;
  const lines: string[] = [];
  const domain = new SshTargetService({
    service,
    keys,
    targets,
    grants,
    locks: new TargetLocks(service),
    hostAddress: (host) => (host === "node1" ? "node1.example" : undefined),
    hostIds: () => ["local", "node1", "node2"],
    audit: (line) => lines.push(line),
  });
  await targets.setNodeAccess("node1", { enabled: true, sourceAddress: "10.0.0.1" });
  await targets.setNodeAccess("node2", { enabled: true, sourceAddress: "10.0.0.2" });
  return { keys, targets, grants, domain, authorized, requested, lines };
}

async function refusal(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error("the work was not refused");
}

/** The status of a `TargetError`, else `undefined`. */
const statusOf = (error: Error): number | undefined => (error instanceof TargetError ? error.status : undefined);

const external = { account: "u", systemType: "linux" as const, nodes: ["node1"], address: "t.example" };

describe("SshTargetService.addTarget", () => {
  test("a managed target takes the address of its host, and local needs a known source", async () => {
    const { domain } = await setup();
    const managed = await domain.addTarget({ ...external, id: "m1", address: undefined, managedHost: "node1" });
    expect(managed.address).toBe("node1.example");
    expect(managed.port).toBe(22);

    const local = await refusal(domain.addTarget({ ...external, id: "m2", address: undefined, managedHost: "local" }));
    expect(local).toBeInstanceOf(TargetError);
    expect(statusOf(local)).toBe(400);
    expect(local.message).toBe("give the address of this host: the hub cannot tell it");

    const none = await refusal(domain.addTarget({ ...external, id: "e1", address: undefined }));
    expect(none.message).toBe("address is required");
  });
});

describe("SshTargetService.setNodeAccess", () => {
  test("a change of local names the provisioners that it makes stale", async () => {
    const { domain, targets } = await setup();
    await targets.setNodeAccess("local", { enabled: true, sourceAddress: "10.0.0.9" });
    await targets.add({ ...external, id: "t1", port: 22 });
    await targets.setProvisioner("t1", {
      fingerprint: "SHA256:x",
      script: "/home/u/provisioner-t1.sh",
      source: "10.0.0.9",
    });

    expect(await domain.setNodeAccess("local", { enabled: true, sourceAddress: "10.0.0.9" })).toEqual({
      pushed: true,
      staleProvisioners: [],
    });
    expect(await domain.setNodeAccess("local", { enabled: true, sourceAddress: "10.0.0.8" })).toEqual({
      pushed: true,
      staleProvisioners: ["t1"],
    });
    expect(await domain.setNodeAccess("node1", { enabled: false, sourceAddress: "" })).toEqual({ pushed: true });
    const unknown = await refusal(domain.setNodeAccess("nope", { enabled: false, sourceAddress: "" }));
    expect(statusOf(unknown)).toBe(404);
  });
});

describe("SshTargetService.changeTarget", () => {
  test("a managed node that does not take the new line keeps the old list and gets the old line back", async () => {
    const { domain, keys, targets, authorized, lines } = await setup({ authorizeFails: new Error("node down") });
    await targets.add({ ...external, id: "t1", port: 22, managedHost: "node1" });
    await keys.create("t1", passphrase(GOOD));

    const error = await refusal(domain.changeTarget("t1", { nodes: ["node2"], by: "ann" }));
    expect(error).toBeInstanceOf(NodeError);
    expect(error.message).toBe("the key line on the machine was not updated, so the node list is as it was: node down");
    expect(authorized).toEqual([["node2"], undefined]);
    expect(targets.get("t1")?.nodes).toEqual(["node1"]);
    expect(lines).toContain('audit ssh target=t1 nodes change failed="node down"');
    // The lock is free again.
    expect((await domain.changeTarget("t1", { state: "disabled", by: "ann" })).kind).toBe("changed");
  });

  test("a store that fails after a good install puts the old line back and keeps the store error", async () => {
    const { domain, keys, targets, authorized } = await setup();
    await targets.add({ ...external, id: "t1", port: 22, managedHost: "node1" });
    await keys.create("t1", passphrase(GOOD));
    const spy = spyOn(targets, "setNodes").mockImplementation(() => Promise.reject(new Error("disk full")));

    const error = await refusal(domain.changeTarget("t1", { nodes: ["node2"], by: "ann" }));
    spy.mockRestore();
    expect(error.message).toBe("disk full");
    expect(authorized).toEqual([["node2"], undefined]);
  });

  test("a good managed change answers lineUpdated, an external change the new line", async () => {
    const { domain, keys, targets } = await setup();
    await targets.add({ ...external, id: "m1", port: 22, managedHost: "node1" });
    await keys.create("m1", passphrase(GOOD));
    const managed = await domain.changeTarget("m1", { nodes: ["node1", "node2"], by: "ann" });
    expect(managed).toMatchObject({ kind: "changed", pushed: true, lineUpdated: true });
    expect(managed).not.toHaveProperty("installLine");

    await targets.add({ ...external, id: "e1", port: 22 });
    await keys.create("e1", passphrase(GOOD));
    const outside = await domain.changeTarget("e1", { nodes: ["node2"], by: "ann" });
    expect(outside.kind === "changed" && outside.installLine).toContain('from="10.0.0.2"');
  });

  test("a target with a provisioner asks for a grant, and a list that locks out needs confirm", async () => {
    const { domain, keys, targets, requested } = await setup();
    await targets.add({ ...external, id: "t1", port: 22 });
    await keys.create("t1", passphrase(GOOD));
    await keys.create("t1", passphrase(GOOD), "provisioner");
    await targets.setProvisioner("t1", {
      fingerprint: "SHA256:x",
      script: "/home/u/provisioner-t1.sh",
      source: "1.2.3.4",
    });

    const both = await refusal(domain.changeTarget("t1", { nodes: ["node2"], state: "disabled", by: "ann" }));
    expect(statusOf(both)).toBe(400);
    const lockOut = await refusal(domain.changeTarget("t1", { nodes: ["node2"], by: "ann" }));
    expect(statusOf(lockOut)).toBe(409);
    expect(lockOut.message).toBe(`${CONFIRM_NODES_TEXT}${CONFIRM_NODES_SUFFIX}`);
    expect(requested).toEqual([]);

    const asked = await domain.changeTarget("t1", { nodes: ["node2"], confirm: true, by: "ann" });
    expect(asked.kind).toBe("maintenance");
    expect(requested).toEqual([{ targetId: "t1", action: "sources", toNodes: ["node2"], by: "ann" }]);
    expect(targets.get("t1")?.nodes).toEqual(["node1"]);
  });

  test("a maintenance grant of the target refuses the change", async () => {
    const { domain, targets } = await setup({ busy: true });
    await targets.add({ ...external, id: "t1", port: 22 });
    const error = await refusal(domain.changeTarget("t1", { state: "disabled", by: "ann" }));
    expect(statusOf(error)).toBe(409);
  });
});

describe("SshTargetService.recordProvisionerInstall", () => {
  test("the script path must be the one of this target, before the lock and the key checks", async () => {
    const { domain, targets } = await setup({ busy: true });
    const target = await targets.add({ ...external, id: "t1", port: 22 });
    const error = await refusal(domain.recordProvisionerInstall(target, "/home/u/provisioner-t2.sh", "ann"));
    expect(statusOf(error)).toBe(400);
    expect(error.message).toBe("script must be the absolute path of the provisioner script of this target");
    const router = await targets.add({ ...external, id: "r1", port: 22, systemType: "dropbear" });
    const routerError = await refusal(domain.recordProvisionerInstall(router, "/home/u/provisioner-r1.sh", "ann"));
    expect(statusOf(routerError)).toBe(400);
  });
});

describe("SshTargetService.checkUnlock", () => {
  test("without an open key, a short passphrase is refused, and with one, the passphrase must open it", async () => {
    const { domain, keys, targets } = await setup();
    const short = await refusal(domain.checkUnlock(passphrase("x".repeat(MIN_PASSPHRASE - 1))));
    expect(statusOf(short)).toBe(400);
    await domain.checkUnlock(passphrase("x".repeat(MIN_PASSPHRASE)));

    await targets.add({ ...external, id: "t1", port: 22 });
    await keys.create("t1", passphrase(GOOD));
    await domain.checkUnlock(passphrase(GOOD));
    const wrong = await refusal(domain.checkUnlock(passphrase("another long passphrase")));
    expect(wrong.name).toBe("KeyError");
  });
});
