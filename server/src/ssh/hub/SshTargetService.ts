import { LOCAL_HOST } from "../../hosts/id";
import { logToken } from "../../roles";
import { keyFingerprint } from "../agentproto";
import { GrantError } from "./GrantStore";
import type { Grant, GrantStore, Maintenance } from "./GrantStore";
import type { KeySlot, SshKeyStore, UnlockSecret } from "./SshKeyStore";
import { provisionScript } from "../provision";
import type { Script } from "../provision";
import {
  CONFIRM_NODES_SUFFIX,
  CONFIRM_NODES_TEXT,
  HAS_PROVISIONER_KEY_TEXT,
  linuxInstallScript,
  routerInstallScript,
  routerScriptPath,
  NO_PROVISIONER_KEY_TEXT,
} from "../provisioner/key";
import { errorKind, NodeError } from "./SshService";
import type { MaintenanceCommit, SshService } from "./SshService";
import type { TargetLocks } from "./TargetLocks";
import { authorizedKeysLine, hasProvisioner, installNotes, SCRIPT_PATH_RE, TargetError } from "../TargetStore";
import type { SystemType, Target, TargetState, TargetStore } from "../TargetStore";

const DEFAULT_PORT = 22;
/** A passphrase that is set (not typed to unlock) needs at least this many characters (code points). */
export const MIN_PASSPHRASE = 12;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface SshTargetServiceDeps {
  service: SshService;
  keys: SshKeyStore;
  targets: TargetStore;
  grants: GrantStore;
  locks: TargetLocks;
  /** The host name of the URL of a remote node, or `undefined` for `local` and for an id that is not a host. */
  hostAddress: (hostId: string) => string | undefined;
  /** The ids of all hosts. */
  hostIds: () => string[];
  /** Where the audit lines go. */
  audit: (line: string) => void;
}

/** How the key lines of a retired target were handled. */
export interface Removal {
  line: "removed" | "not-found" | "failed" | "manual";
  detail?: string;
}

/** The answer of a retire. It names the lines that stay on the machine when the hub did not remove them. */
export interface RetireReport {
  id: string;
  account: string;
  address: string;
  port: number;
  systemType: SystemType;
  managed: boolean;
  line: Removal["line"];
  detail?: string;
  comments?: string[];
  script?: string;
}

export interface NewTargetInput {
  id: string;
  account: string;
  systemType: SystemType;
  nodes: string[];
  managedHost?: string;
  keyFile?: string;
  address?: string;
  port?: number;
}

export interface TargetChange {
  state?: TargetState;
  nodes?: string[];
  confirm?: boolean;
  by: string;
}

/** A change that waits for a maintenance grant, or a change that is stored. */
export type ChangeResult =
  | { kind: "maintenance"; grant: Grant }
  | { kind: "changed"; target: Target | undefined; pushed?: boolean; installLine?: string; lineUpdated?: true };

export type RetireResult = { kind: "maintenance"; grant: Grant } | { kind: "retired"; report: RetireReport };

/** The result of an approve: a plain grant (also `install`), or the extra parts of `sources` and `uninstall`. */
export type ApproveResult =
  | { kind: "grant"; grant: Grant }
  | { kind: "sources"; grant: Grant; target: Target | undefined; pushed: boolean }
  | { kind: "uninstall"; grant: Grant; retired: RetireReport };

export interface NodeAccessResult {
  pushed: boolean;
  /** For `local` only: the targets whose provisioner no longer allows the source of `local`. */
  staleProvisioners?: string[];
}

export interface KeyMade {
  publicLine: string;
  fingerprint: string;
}

/**
 * The rules of SSH targets on the hub: the change of node lists, the retire, the keys and the provisioner, and the
 * approve of maintenance grants. The routes in `sshapi.ts` parse a request, call one method and map the result.
 * Every method that changes a target takes its lock in `TargetLocks` before its first await.
 *
 * An external target with a provisioner (a provisioner key and an installed script) changes through a maintenance
 * grant: read the comment at the top of `sshapi.ts`.
 */
export class SshTargetService {
  constructor(private readonly deps: SshTargetServiceDeps) {}

  /** The target, or 404. */
  need(id: string): Target {
    const target = this.deps.targets.get(id);
    if (!target) throw new TargetError(404, "no such target");
    return target;
  }

  hasKey(targetId: string, slot: KeySlot = "main"): boolean {
    try {
      this.deps.keys.publicLine(targetId, slot);
      return true;
    } catch {
      return false;
    }
  }

  /** A key that a passphrase can be checked against: it exists and a recovery has not made it wait for a re-wrap. */
  hasOpenKey(targetId: string, slot: KeySlot = "main"): boolean {
    return this.hasKey(targetId, slot) && !this.deps.keys.pendingRewraps(slot).includes(targetId);
  }

  /** An external target whose changes go through a maintenance grant: its provisioner fields and key are there. */
  withProvisioner(target: Target): boolean {
    return target.managedHost === undefined && hasProvisioner(target) && this.hasKey(target.id, "provisioner");
  }

  /**
   * A passphrase is shared by all keys, so a typo would seal a key under a passphrase that no one knows: check it
   * against a key that is open (any target, any slot). Without one, only the length is checked. A passkey makes
   * another secret for each salt, so there is nothing to check against.
   */
  async checkUnlock(unlock: UnlockSecret): Promise<void> {
    if (unlock.method !== "passphrase") return;
    const other = this.deps.targets
      .list()
      .flatMap((item) => (["main", "provisioner"] as const).map((slot) => ({ id: item.id, slot })))
      .find((item) => this.hasOpenKey(item.id, item.slot));

    if (other) (await this.deps.keys.open(other.id, unlock, other.slot)).destroy();
    else needLongPassphrase(unlock);
  }

  /** Only an external target of a POSIX type has a provisioner key. */
  needProvisionerTarget(target: Target): void {
    if (target.managedHost !== undefined) throw new TargetError(400, "a managed target has no provisioner key");
    if (target.systemType === "windows") throw new TargetError(400, "a windows target has no provisioner key");
  }

  /** The state of SSH access for `GET /status`. */
  status() {
    const { keys, targets } = this.deps;
    const nodes = this.deps.hostIds().map((host) => {
      const access = targets.nodeAccess(host);
      return { host, enabled: access?.enabled ?? false, sourceAddress: access?.sourceAddress ?? "" };
    });
    const method = keys.method();
    const credentialId = keys.credentialId();
    return {
      setUp: keys.isSetUp(),
      ...(method ? { method } : {}),
      ...(credentialId ? { credentialId } : {}),
      pendingRewrap: keys.pendingRewraps(),
      pendingProvisionerRewrap: keys.pendingRewraps("provisioner"),
      hasKeys: targets.list().some((item) => this.hasOpenKey(item.id)),
      nodes,
    };
  }

  /** Starts a recovery. A recovery follows a lost or stolen unlock: a grant that it approved must not outlive it. */
  async beginRecovery(
    input: { code: string; method: "prf" | "passphrase"; credentialId?: string },
    by: string,
  ): Promise<{ targets: string[] }> {
    const { keys, grants } = this.deps;
    const { targets: pending } = await keys.beginRecovery(input);
    grants.endWhere((grant) => grant.state === "active", "revoked");
    this.deps.audit(
      `audit ssh recovery user=${logToken(by)} method=${input.method} targets=${pending.length} provisioner=${keys.pendingRewraps("provisioner").length}`,
    );
    return { targets: pending };
  }

  /** Sets the SSH access of a node and tells it. */
  async setNodeAccess(host: string, access: { enabled: boolean; sourceAddress: string }): Promise<NodeAccessResult> {
    if (!this.deps.hostIds().includes(host)) throw new TargetError(404, "no such host");
    await this.deps.targets.setNodeAccess(host, access);
    const pushed = await this.push([host]);
    if (host !== LOCAL_HOST) return { pushed };
    // The provisioner line of each target allows the source of `local` at its install only. After a change, the
    // maintenance of those targets is refused until the owner installs the provisioner again.
    const staleProvisioners = this.deps.targets
      .list()
      .filter((item) => hasProvisioner(item) && (!access.enabled || item.provisionerSource !== access.sourceAddress))
      .map((item) => item.id);
    return { pushed, staleProvisioners };
  }

  /** Adds a target. Without an address, a managed target takes the address of its host. */
  async addTarget(input: NewTargetInput): Promise<Target> {
    let address = input.address;

    if (address === undefined && input.managedHost === LOCAL_HOST) {
      // The hub cannot tell how the other nodes see its own host, and the public URL names another machine.
      const known = this.deps.targets.nodeAccess(LOCAL_HOST)?.sourceAddress;
      if (!known) throw new TargetError(400, "give the address of this host: the hub cannot tell it");
      address = known;
    } else if (address === undefined && input.managedHost !== undefined)
      address = this.deps.hostAddress(input.managedHost);

    if (address === undefined) throw new TargetError(400, "address is required");

    const target = await this.deps.targets.add({
      id: input.id,
      address,
      port: input.port ?? DEFAULT_PORT,
      account: input.account,
      systemType: input.systemType,
      nodes: input.nodes,
      ...(input.managedHost !== undefined ? { managedHost: input.managedHost } : {}),
      ...(input.keyFile !== undefined ? { keyFile: input.keyFile } : {}),
    });
    await this.push(target.nodes);
    return target;
  }

  /**
   * Changes the state, the nodes or both. A new list of nodes changes the `from=` part of the key line of the target:
   * a managed target gets the new line before the list is stored, and a failed install leaves the list as it was
   * (`NodeError`), because a list that the machine does not match would let the hub approve a node that the machine
   * refuses. An external target gets the new line in the result (`installLine`). The grants of a node that left the
   * list end. The nodes of the old and the new list get the target list, after the lock is freed.
   * An external target with a key and a provisioner stores nothing here: a new list asks for a `sources` maintenance
   * grant. When the new list allows none of the addresses of the old list, it needs `confirm` (else 409).
   */
  async changeTarget(id: string, change: TargetChange): Promise<ChangeResult> {
    const { nodes, state } = change;
    let newLine: string | undefined;
    let lineUpdated = false as boolean;
    let pushHosts: string[] = [];

    const grant = await this.deps.locks.run<Grant | undefined>("edit", id, async () => {
      // Read again under the lock: the target can have changed while the body was read.
      const target = this.need(id);
      pushHosts = target.nodes;

      if (nodes !== undefined && this.hasKey(target.id) && this.withProvisioner(target))
        return this.requestSources(target, nodes, change);

      if (nodes !== undefined) {
        const next = { ...target, nodes };
        const withKey = this.hasKey(target.id);
        // A target with a key keeps a valid line only while one node has access and a source address.
        if (withKey && this.deps.targets.sourcesOf(next).length === 0)
          throw new TargetError(409, "no node of the new list has access enabled with a source address");

        if (withKey && target.managedHost !== undefined) {
          await this.changeManagedNodes(target, nodes);
          lineUpdated = true;
        } else {
          await this.deps.targets.setNodes(target.id, nodes);
          // A Dropbear line has no address limit, so a change of the nodes does not change it: no new line to paste.
          if (withKey && target.systemType !== "dropbear") newLine = this.installLine(next);
        }

        const removed = target.nodes.filter((node) => !nodes.includes(node));
        if (removed.length > 0) this.endGrantsOf(target.id, removed);
        pushHosts = [...target.nodes, ...nodes];
      }

      if (state !== undefined) {
        if (state === "disabled") this.endGrantsOf(target.id);
        await this.deps.targets.setState(target.id, state);
      }

      return undefined;
    });
    if (grant) return { kind: "maintenance", grant };

    const pushed = await this.push(pushHosts);
    return {
      kind: "changed",
      target: this.deps.targets.get(id),
      ...(nodes !== undefined ? { pushed } : {}),
      ...(newLine !== undefined ? { installLine: newLine } : {}),
      ...(lineUpdated ? { lineUpdated: true as const } : {}),
    };
  }

  /**
   * Retires a target: the grants end, a managed node removes the key line, then the key and the record go. The target
   * is disabled first, so that no request and no approval gets a key meanwhile. A target with a provisioner is not
   * deleted here, unless `manual`: the result is an `uninstall` maintenance grant, and its approve retires.
   */
  async retire(id: string, options: { manual: boolean; by: string }): Promise<RetireResult> {
    const { targets, grants, service } = this.deps;
    const target = this.need(id);

    return this.deps.locks.run("retire", target.id, async (): Promise<RetireResult> => {
      if (!options.manual && this.withProvisioner(target)) {
        // The checks of the grant come first, so a refusal changes nothing.
        const grant = service.requestMaintenance({ targetId: target.id, action: "uninstall", by: options.by });

        try {
          await targets.setState(target.id, "disabled");
        } catch (error) {
          if (grants.get(grant.id)?.state === "pending") grants.deny(grant.id, "system");
          throw error;
        }

        this.endGrantsOf(target.id);
        await this.push(target.nodes);
        return { kind: "maintenance", grant: grants.get(grant.id) ?? grant };
      }

      await targets.setState(target.id, "disabled");
      this.endGrantsOf(target.id);
      // The key line is read before the key is deleted. A failed removal never stops the retire.
      const removal: Removal =
        target.managedHost === undefined ? { line: "manual" } : await service.deauthorizeManaged(target.id);
      return { kind: "retired", report: await this.finishRetire(target, removal) };
    });
  }

  /** The salt of a key, with the unlock method. */
  async salt(target: Target, slot: KeySlot) {
    if (slot === "provisioner") this.needProvisionerTarget(target);
    // A salt that is made while a retire runs could stay behind after the retire.
    if (this.deps.locks.isRetiring(target.id)) throw new TargetError(409, "this target is being retired");
    const { keys } = this.deps;
    const method = keys.method();
    const credentialId = keys.credentialId();
    return {
      salt: await keys.saltFor(target.id, slot),
      method,
      ...(credentialId ? { credentialId } : {}),
    };
  }

  /** Seals a key again after a recovery. */
  async rewrap(target: Target, code: string, unlock: UnlockSecret, slot: KeySlot, by: string): Promise<void> {
    if (!this.deps.keys.pendingRewraps(slot).includes(target.id))
      throw new TargetError(409, "this target does not need a re-wrap");
    // A typed passphrase is checked against a key that is open already, so a typo cannot seal this key under it.
    // The re-wrap itself is safe against a retire: it fails when the key is gone, and writes nothing then.
    await this.checkUnlock(unlock);
    await this.deps.keys.rewrapWithRecovery(target.id, code, unlock, slot);
    this.deps.audit(
      `audit ssh rewrap user=${logToken(by)} target=${logToken(target.id)}${slot === "main" ? "" : ` key=${slot}`}`,
    );
  }

  /** Makes the main key. */
  async createKey(id: string, unlock: UnlockSecret) {
    // The lock keeps a retire from deleting the target between the checks and the write of the key. The target is read
    // again under the lock: a retire can run while the body arrives.
    return this.deps.locks.run("edit", id, async () => {
      const target = this.need(id);
      if (this.hasKey(target.id)) throw new TargetError(409, "the target has a key already");
      const sources = this.deps.targets.sourcesOf(target);
      if (sources.length === 0)
        throw new TargetError(409, "no node of this target has access enabled with a source address");

      await this.checkUnlock(unlock);
      const made = await this.deps.keys.create(target.id, unlock);
      await this.deps.targets.setKeyFingerprint(target.id, made.fingerprint);
      return {
        publicLine: made.publicLine,
        fingerprint: made.fingerprint,
        installLine: authorizedKeysLine(made.publicLine, sources, target.systemType),
        notes: installNotes(target.systemType),
      };
    });
  }

  /** Makes the provisioner key. `target` is the target as it was before the body was read. */
  async createProvisionerKey(target: Target, unlock: UnlockSecret): Promise<KeyMade> {
    this.needProvisionerTarget(target);

    return this.deps.locks.run("edit", target.id, async () => {
      // A retire can run while the body arrives: read the target again under the lock.
      this.needProvisionerTarget(this.need(target.id));
      // The unlock is checked first: a 409 must never hide a wrong passphrase, because the CLI replaces a key that
      // exists, and a replace with a typo would remove the working key.
      await this.checkUnlock(unlock);
      if (this.hasKey(target.id, "provisioner")) throw new TargetError(409, HAS_PROVISIONER_KEY_TEXT);
      const made = await this.deps.keys.create(target.id, unlock, "provisioner");
      return { publicLine: made.publicLine, fingerprint: made.fingerprint };
    });
  }

  /** Removes the provisioner key and the record of its install. The main key stays. */
  async removeProvisionerKey(target: Target, by: string): Promise<void> {
    await this.deps.locks.run("edit", target.id, async () => {
      if (!this.hasKey(target.id, "provisioner") && !hasProvisioner(target))
        throw new TargetError(404, NO_PROVISIONER_KEY_TEXT);
      await this.deps.keys.removeSlot(target.id, "provisioner");
      await this.deps.targets.setProvisioner(target.id, undefined);
      this.deps.audit(`audit ssh target=${logToken(target.id)} provisioner key removed user=${logToken(by)}`);
    });
  }

  /** The install script of the provisioner, by system type: a dropbear target is a router (Asuswrt-Merlin). */
  provisionerInstallScript(target: Target) {
    this.needInstallable(target);
    const localSource = this.needLocalSource();
    const sources = this.deps.targets.sourcesOf(target);
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");

    try {
      const input = {
        targetId: target.id,
        mainPublicLine: this.deps.keys.publicLine(target.id),
        provisionerPublicLine: this.deps.keys.publicLine(target.id, "provisioner"),
        localSource,
        sources,
      };
      return target.systemType === "dropbear" ? routerInstallScript(input) : linuxInstallScript(input);
    } catch (error) {
      // A source with a pattern, for example: the script takes exact addresses and host names only.
      throw new TargetError(409, `the install script cannot be made: ${message(error)}`);
    }
  }

  /**
   * Records the install of the provisioner. The fingerprint comes from the stored key and the source from the access
   * of `local` now, never from the request. `target` is the target as it was before the body was read.
   */
  async recordProvisionerInstall(target: Target, script: unknown, by: string): Promise<Target | undefined> {
    this.needProvisionerTarget(target);
    // The router script has one fixed path. The Linux script is in the home folder of the account.
    const pathOk =
      typeof script === "string" &&
      SCRIPT_PATH_RE.test(script) &&
      (target.systemType === "dropbear"
        ? script === routerScriptPath(target.id)
        : script.endsWith(`/provisioner-${target.id}.sh`));
    if (!pathOk)
      throw new TargetError(400, "script must be the absolute path of the provisioner script of this target");

    return this.deps.locks.run("edit", target.id, async () => {
      // A retire can run while the body arrives: read the target again under the lock.
      const current = this.need(target.id);
      this.needInstallable(current);
      const source = this.needLocalSource();
      const blob = this.deps.keys.publicLine(current.id, "provisioner").split(" ")[1] ?? "";
      const fingerprint = keyFingerprint(new Uint8Array(Buffer.from(blob, "base64")));
      await this.deps.targets.setProvisioner(current.id, { fingerprint, script, source });
      this.deps.audit(`audit ssh target=${logToken(current.id)} provisioner installed user=${logToken(by)}`);
      return this.deps.targets.get(current.id);
    });
  }

  /** Asks for an `install` maintenance grant: it puts the main line back on the target with the stored list. */
  reinstall(target: Target, by: string): Grant {
    this.deps.locks.needIdle(target.id);
    return this.deps.service.requestMaintenance({ targetId: target.id, action: "install", by });
  }

  /** The script that installs the main key line on an external target. */
  provision(target: Target): Script {
    return provisionScript(target.systemType, this.installLine(target), { account: target.account });
  }

  /**
   * Approves a grant. For a maintenance grant, the approve runs the action and commits the change under the lock of
   * the target: `sources` stores the new list, `uninstall` retires, `install` only runs.
   */
  async approve(
    grantId: string,
    unlock: UnlockSecret,
    minutes: number | undefined,
    by: string,
  ): Promise<ApproveResult> {
    const { grants, service } = this.deps;
    const waiting = grants.get(grantId);
    const work = waiting?.state === "pending" ? waiting.maintenance : undefined;
    if (!waiting || !work) return { kind: "grant", grant: await service.approve(grantId, by, unlock, minutes) };

    const lock = work.action === "uninstall" ? "retire" : "edit";

    return this.deps.locks.hold(lock, waiting.targetId, async (): Promise<ApproveResult> => {
      if (work.action === "sources") return await this.approveSources(grantId, work, unlock, by);
      if (work.action === "uninstall") return await this.approveUninstall(grantId, unlock, by);
      const grant = await service.approve(grantId, by, unlock);
      if (grant.maintenance?.result !== "done")
        throw new NodeError(`the key line was not put back on the machine: ${detailOf(grant)}`);
      return { kind: "grant", grant };
    });
  }

  /** The approve of a `sources` grant: the run, then the new list in the store, while the grant is still active. */
  private async approveSources(
    grantId: string,
    work: Maintenance,
    unlock: UnlockSecret,
    by: string,
  ): Promise<ApproveResult> {
    const { grants, targets, service, audit } = this.deps;
    const targetId = grants.get(grantId)?.targetId ?? "";

    const commit: MaintenanceCommit = async (grant, signal) => {
      const plan = grant.maintenance;
      const toNodes = plan?.toNodes;
      if (!plan || !toNodes) throw new Error("the grant has no node list");
      await targets.setNodes(targetId, toNodes);

      if (signal.aborted) {
        // The time limit passed during the write, and the old list went back on the target: so it goes back here too.
        // Only while the store still holds this list, in one change of the store: a newer change is never undone.
        // The lock of the target holds until this settles, so no newer change can start meanwhile.
        await targets.setNodesIf(targetId, toNodes, plan.fromNodes).then(
          (undone) => {
            audit(`audit ssh target=${logToken(targetId)} late commit ${undone ? "undone" : "not-undone"}`);
          },
          (error: unknown) => {
            audit(`audit ssh target=${logToken(targetId)} late commit undo failed=${errorKind(error)}`);
          },
        );
        return;
      }

      // The grants of the nodes that left the list end (a maintenance grant never does).
      const removed = plan.fromNodes.filter((node) => !toNodes.includes(node));
      if (removed.length > 0) this.endGrantsOf(targetId, removed);
    };

    const grant = await service.approve(grantId, by, unlock, undefined, { commit });
    if (grant.maintenance?.result !== "done")
      throw new NodeError(
        `the key line on the machine was not updated, so the node list is as it was: ${detailOf(grant)}`,
      );
    const pushed = await this.push([...work.fromNodes, ...(work.toNodes ?? [])]);
    return { kind: "sources", grant, target: targets.get(targetId), pushed };
  }

  /**
   * The approve of an `uninstall` grant. Once the owner approved it, the retire goes on whatever the run gave: a line
   * without its private key is harmless, and the answer names the lines to remove by hand. A refusal before the
   * approve (a wrong unlock, a change that is out of date) stops the retire, and the target stays `disabled`.
   */
  private async approveUninstall(grantId: string, unlock: UnlockSecret, by: string): Promise<ApproveResult> {
    const { grants, targets, service } = this.deps;
    const target = targets.get(grants.get(grantId)?.targetId ?? "");
    let failure: { error: unknown } | undefined;

    try {
      await service.approve(grantId, by, unlock);
    } catch (error) {
      failure = { error };
    }

    const grant = grants.get(grantId);
    if (!target || grant?.approvedAt === undefined)
      throw failure ? failure.error : new GrantError(404, "no such grant");

    // A revoke or an expiry before any step ran touched nothing on the target: it is a deny. The target stays
    // `disabled` with both keys, and the owner can send the retire again or retire without cleanup.
    const endedEarly = grant.endReason === "revoked" || grant.endReason === "expired";

    if (endedEarly && grant.maintenance?.started !== true) {
      if (failure) throw failure.error;
      throw new TargetError(
        409,
        "the grant ended before the run started, so the target stays disabled: retire it again, or retire it without cleanup",
      );
    }

    const removed = !failure && grant.maintenance?.result === "done";
    const why = failure ? message(failure.error) : detailOf(grant);
    const removal: Removal = removed
      ? { line: "removed" }
      : {
          line: "failed",
          detail: `${why}. The key lines stay on the machine: remove the lines that end with claude-rc:${target.id} and claude-rc-provisioner:${target.id}`,
        };
    return { kind: "uninstall", grant, retired: await this.finishRetire(target, removal) };
  }

  /** Asks for a `sources` maintenance grant, with the lock-out rule. */
  private requestSources(target: Target, nodes: string[], change: TargetChange): Grant {
    if (change.state !== undefined)
      throw new TargetError(400, "for a target with a provisioner, send the state and the nodes in two calls");
    const fromSources = this.deps.targets.sourcesOf(target);
    const toSources = this.deps.targets.sourcesOf({ nodes });
    if (toSources.length === 0)
      throw new TargetError(409, "no node of the new list has access enabled with a source address");
    // With no address that works now, there is nothing to lock out, so no confirm is needed. A Dropbear line has no
    // address limit, so a new list cannot lock anyone out there either.
    if (
      target.systemType !== "dropbear" &&
      fromSources.length > 0 &&
      !toSources.some((source) => fromSources.includes(source)) &&
      change.confirm !== true
    )
      throw new TargetError(409, `${CONFIRM_NODES_TEXT}${CONFIRM_NODES_SUFFIX}`);
    return this.deps.service.requestMaintenance({
      targetId: target.id,
      action: "sources",
      toNodes: nodes,
      by: change.by,
    });
  }

  /**
   * The node list of a managed target with a key. The line goes to the machine before the list is stored, so a failed
   * install leaves the store as it was and no node of the new list is trusted meanwhile. The script writes nothing
   * when the exact line is there. On a failure, the old line goes back on the machine.
   */
  private async changeManagedNodes(target: Target, nodes: string[]): Promise<void> {
    const { service, targets, audit } = this.deps;

    try {
      await service.authorizeManaged(target.id, nodes);
    } catch (error) {
      // The machine may have taken the new line before the failure: try to put the old line back.
      await this.restoreLine(target.id);
      audit(`audit ssh target=${logToken(target.id)} nodes change failed=${logToken(message(error))}`);
      throw new NodeError(
        `the key line on the machine was not updated, so the node list is as it was: ${message(error)}`,
      );
    }

    try {
      await targets.setNodes(target.id, nodes);
    } catch (error) {
      // The machine has the new line, the store the old list: put the old line back and keep this error.
      await this.restoreLine(target.id);
      throw error;
    }
  }

  /** Puts the line of the stored list back on a managed machine. A failure is noted only. */
  private async restoreLine(targetId: string): Promise<void> {
    await this.deps.service.authorizeManaged(targetId).catch((again: unknown) => {
      this.deps.audit(`audit ssh target=${logToken(targetId)} line restore failed=${logToken(message(again))}`);
    });
  }

  /**
   * The last steps of a retire: both keys and the record go, the grants end, and the nodes are told. The answer names
   * the lines that stay on the machine when the hub did not remove them, and the script of a provisioner.
   */
  private async finishRetire(target: Target, removal: Removal): Promise<RetireReport> {
    await this.deps.keys.remove(target.id);
    await this.deps.targets.remove(target.id);
    this.endGrantsOf(target.id);
    await this.push(target.nodes);
    this.deps.audit(`audit ssh target=${logToken(target.id)} retired line=${removal.line}`);
    const left = hasProvisioner(target) && (removal.line === "failed" || removal.line === "manual");
    return {
      id: target.id,
      account: target.account,
      address: target.address,
      port: target.port,
      systemType: target.systemType,
      managed: target.managedHost !== undefined,
      line: removal.line,
      ...(removal.detail !== undefined ? { detail: removal.detail } : {}),
      ...(left
        ? {
            comments: [`claude-rc:${target.id}`, `claude-rc-provisioner:${target.id}`],
            script: target.provisionerScript,
          }
        : {}),
    };
  }

  /** The checks of an install of a provisioner, for the script and for the record of its result. */
  private needInstallable(target: Target): void {
    this.needProvisionerTarget(target);
    if (!this.hasKey(target.id)) throw new TargetError(409, "the target has no key: make the main key first");
    if (!this.hasKey(target.id, "provisioner")) throw new TargetError(409, NO_PROVISIONER_KEY_TEXT);
  }

  /** The source address of the node `local`, or a 409. The hub reaches a target through it. */
  private needLocalSource(): string {
    const local = this.deps.targets.nodeAccess(LOCAL_HOST);
    if (local?.enabled !== true || !local.sourceAddress)
      throw new TargetError(409, "turn on SSH access for the node local with a source address");
    return local.sourceAddress;
  }

  private installLine(target: Target): string {
    const sources = this.deps.targets.sourcesOf(target);
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");
    return authorizedKeysLine(this.deps.keys.publicLine(target.id), sources, target.systemType);
  }

  /** Tells the nodes their targets. A node that cannot be reached is noted: the change itself stands. */
  private async push(hostIds: string[]): Promise<boolean> {
    let all = true;

    for (const hostId of new Set(hostIds)) {
      try {
        await this.deps.service.pushTargets(hostId);
      } catch (error) {
        all = false;
        this.deps.audit(`audit ssh node=${logToken(hostId)} push failed=${logToken(message(error))}`);
      }
    }

    return all;
  }

  /**
   * A disable or a retire ends the active grants and refuses the pending ones: the node tells the waiting session.
   * With `hostIds`, only the grants of those nodes end (a node that left the list of the target).
   */
  // A maintenance grant is never ended here: the disable of a retire and the change of nodes run while the grant that
  // does the work is pending or active, and `local` can be a session node of the target that leaves the list.
  private endGrantsOf(targetId: string, hostIds?: string[]): void {
    this.deps.grants.endWhere(
      (grant) =>
        grant.maintenance === undefined &&
        grant.targetId === targetId &&
        (hostIds === undefined || hostIds.includes(grant.nodeId)),
      "target-disabled",
    );
  }
}

/** The detail of a maintenance run, for a text. */
function detailOf(grant: Grant): string {
  const detail = grant.maintenance?.detail ?? "";
  return detail === "" ? "the run failed" : detail;
}

/** A passphrase that is set (not typed to unlock) needs at least MIN_PASSPHRASE characters. The text is never echoed. */
function needLongPassphrase(unlock: UnlockSecret): void {
  if (unlock.method !== "passphrase") return;
  // The decoder drops a leading byte order mark (U+FEFF), so it is not counted. The web counts the same way.
  let count = 0;
  for (const _point of new TextDecoder().decode(unlock.secret)) count++;
  if (count < MIN_PASSPHRASE) throw new TargetError(400, `the passphrase needs at least ${MIN_PASSPHRASE} characters`);
}
