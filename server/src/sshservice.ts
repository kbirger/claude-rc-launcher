import { realTimers } from "./shared/PollSource";
import type { Timers } from "./shared/PollSource";
import type { HostClient } from "./hosts/client";
import { HOST_ID_RE, LOCAL_HOST } from "./hosts/id";
import { HttpError } from "./instances/InstanceService";
import { isObject } from "./shared/requests";
import { logToken } from "./roles";
import { GrantError } from "./sshgrants";
import type { Grant, GrantStore, Maintenance, MaintenanceAction } from "./sshgrants";
import { KeyError } from "./sshkeystore";
import type { KeySlot, SshKeyStore, UnlockSecret } from "./sshkeystore";
import { defaultRunner, runProvisioner } from "./sshmaintenance";
import type { SshRunner } from "./sshmaintenance";
import { NO_WAITING_REQUEST } from "./sshnodeapi";
import { formatCommand, validSources } from "./sshprovisioner";
import type { ProvisionerAnswer, ProvisionerCommand } from "./sshprovisioner";
import { authorizedKeysLine, hasProvisioner, MAX_NODES, TargetError } from "./sshtargets";
import type { Target, TargetStore } from "./sshtargets";

// Hub service for SSH delegation. It joins the key store, the target store and the grant store to the nodes. A node
// asks for a grant with the `ssh.request` event. An admin approves it with an unlock, and the service then gives the
// public key of the target and the host key to the node (`POST /api/ssh/grants`). While the grant is active the node
// sends each sign request as an `ssh.sign` event, and the service answers it with `POST /api/ssh/sign-result`. The
// private key never leaves the hub. Every grant needs a new unlock: the service keeps no key and no secret, because
// the grant store holds the key until the grant ends.
// The node routes are the ones of `sshnodeapi.ts`, below `/api` like all node routes. A call to a node that fails is
// audited and never thrown out of an event handler or of `onGrantEnd`.

const NODE_API = "/api/ssh";
const MAX_REASON = 500;
const MAX_BLOB_CHARS = 100_000;
const PROBE_TIMEOUT_MS = 60_000;
const SCAN_TIMEOUT_MS = 30_000;
const SCRIPT_TIMEOUT_MS = 90_000;
const DEAUTHORIZE_TIMEOUT_MS = 10_000;
const MAX_DETAIL = 200;
const STOPPED_WAITING = "The session stopped waiting. Ask the session to request again.";
/** The instance id of a maintenance grant. A real instance id has 12 hex characters, so it never matches one. */
export const MAINTENANCE_INSTANCE = "maintenance";
export const MAINTENANCE_BUSY = "a maintenance request waits for this target";
export const OUT_OF_DATE = "the change is out of date: start it again";
const NO_SSH_PROGRAM = "the hub has no ssh program: install the OpenSSH client on the hub machine";
/** The time that the `commit` of a maintenance run gets. The grant lasts one minute, and the restore needs time too. */
const COMMIT_TIMEOUT_MS = 10_000;
export const COMMIT_TIMEOUT_TEXT = "the change could not be stored in time";
/**
 * The exit codes of the script that mean it refused before it wrote anything: bad-command (2), unsafe-file (3),
 * guard (4) and no-sources (5). A write-failed (6) can follow a write of the key line, so it is not in the list.
 */
const NOTHING_WRITTEN_CODES = new Set([2, 3, 4, 5]);

/** A node that cannot be reached, or that answers with an error, when the hub asks it for something (502 for a route). */
export class NodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeError";
  }
}

export interface HostKeyLine {
  line: string;
  fingerprint: string;
}

interface Deps {
  keys: SshKeyStore;
  targets: TargetStore;
  grants: GrantStore;
  client: (hostId: string) => HostClient | undefined;
  audit: (line: string) => void;
  /** Called once for each real request that became pending. A throw is audited and does not fail the request. */
  notify?: (grant: Grant, target: Target) => void;
  /** Called once when a real (not test) grant leaves `pending`, so that the request notification can close. */
  notifyClose?: (grant: Grant) => void;
  /** Called once for each new maintenance request. A throw is audited and does not fail the request. */
  notifyMaintenance?: (grant: Grant, target: Target) => void;
  /** Runs one `ssh` child process for a maintenance grant. Default: `defaultRunner` of `sshmaintenance.ts`. */
  runSsh?: SshRunner;
  /** Whether the hub machine has an `ssh` program. Default: `Bun.which("ssh")`. */
  hasSsh?: () => boolean;
  /** Whether the host `local` has the grant routes (not on Windows). Default: a client for `local` exists. */
  localReady?: () => boolean;
  /** The timers of the commit time limit. Default: real timers. */
  timers?: Timers;
  /** The time limit of the `commit` of a maintenance run, in ms. Default: 10 seconds. */
  commitTimeoutMs?: number;
}

/**
 * The hook that stores the change of a good maintenance run, while the grant is still active. `signal` aborts when the
 * time limit passes: the run then counts as failed and the old list goes back on the target, so a commit that ends
 * late must undo its write.
 */
export type MaintenanceCommit = (grant: Grant, signal: AbortSignal) => Promise<void>;

/** One step of a maintenance run: a command and the check of its answer. */
interface Step {
  command: ProvisionerCommand;
  check: (answer: ProvisionerAnswer) => boolean;
  wrong: string;
}

/** The outcome of a maintenance run. */
interface Outcome {
  result: "done" | "failed";
  detail?: string;
  /** A step that changes the target finished, and no restore undid it. */
  changed: boolean;
}

/** What the restore of the old list did. */
interface Restore {
  attempted: boolean;
  ok: boolean;
  error?: string;
}

const CHANGED_TEXT = "the target already holds part of the change";
const RESTORE_FAILED_TEXT = "the old list could not be put back";

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isOk = (status: number) => status >= 200 && status < 300;

/** The text of an error body (`{ error }`), for a message. */
function errorText(body: unknown, status: number): string {
  if (isObject(body) && typeof body.error === "string" && body.error) return body.error;
  return `the node answered with status ${status}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The class of an error and its status or code, for an audit line: never its text, which can hold a path. */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const extra = error as { status?: unknown; code?: unknown };
  const code =
    typeof extra.status === "number" ? extra.status : typeof extra.code === "string" ? extra.code : undefined;
  return logToken(code === undefined ? error.name : `${error.name}:${code}`);
}

export class SshService {
  constructor(private readonly deps: Deps) {}

  /** A node event whose name starts with `ssh.`. It never throws, and it does not wait for the work. */
  onNodeEvent(hostId: string, event: string, data: unknown): void {
    let work: Promise<void> | undefined;

    try {
      if (event === "ssh.request") work = this.onRequest(hostId, data);
      else if (event === "ssh.sign") work = this.onSign(hostId, data);
      else if (event === "ssh.instance-off") this.onInstanceOff(hostId, data);
    } catch (error) {
      this.note(`event=${logToken(event)} node=${logToken(hostId)} failed=${logToken(message(error))}`);
    }

    work?.catch((error: unknown) => {
      this.note(`event=${logToken(event)} node=${logToken(hostId)} failed=${logToken(message(error))}`);
    });
  }

  /** The node came online: it forgets what it holds (the hub holds no grant for it any more), then it gets its targets. */
  async onNodeOnline(hostId: string): Promise<void> {
    this.deps.grants.endWhere((grant) => grant.nodeId === hostId && grant.state === "active", "node-lost");

    try {
      const reply = await this.nodeCall(hostId, "POST", "/reset");
      // A Windows node answers 501 to the grant routes: it has nothing to reset.
      if (reply.status === 501) return;
      if (!isOk(reply.status)) throw new Error(errorText(reply.body, reply.status));
      await this.pushTargets(hostId);
    } catch (error) {
      this.note(`event=online node=${logToken(hostId)} reset-or-push failed=${logToken(message(error))}`);
    }
  }

  /** The node lost its stream: its active grants end, because the node cannot be told to stop them. */
  onNodeOffline(hostId: string): void {
    this.deps.grants.endWhere((grant) => grant.nodeId === hostId && grant.state === "active", "node-lost");
  }

  /** The node was removed from the hub: all its grants end, the pending ones too, because it never comes back. */
  onNodeRemoved(hostId: string): void {
    this.deps.grants.endWhere((grant) => grant.nodeId === hostId, "node-lost");
  }

  /**
   * Opens the key with the unlock, starts the grant and gives it to the node. A wrong unlock leaves the grant pending
   * (403). A node that cannot take the grant ends it with `node-lost`, and the call fails with 409.
   * A maintenance grant opens the provisioner key, never the main key, and a plain grant never opens the provisioner key.
   * For a maintenance grant, the call then runs the action on the target, records the result and ends the grant: the
   * answer holds `maintenance.result`. A maintenance grant whose change is out of date ends at once (409).
   * `options.commit` (maintenance only) runs after a good run and before the grant ends. When it throws, the old list
   * goes back on the target in the same grant, the result is `failed`, and the call throws the error of `commit`.
   * A `commit` that does not end within the time limit fails the same way, with `COMMIT_TIMEOUT_TEXT`.
   */
  async approve(
    grantId: string,
    by: string,
    unlock: UnlockSecret,
    minutes?: number,
    options: { commit?: MaintenanceCommit } = {},
  ): Promise<Grant> {
    const { grants, keys } = this.deps;
    const grant = grants.get(grantId);
    if (!grant) throw new GrantError(404, "no such grant");
    if (grant.state !== "pending") throw new GrantError(409, `grant is ${grant.state}`);
    // First for a maintenance grant: a grant that can never run ends here, and the lock of the target clears.
    this.checkStillCurrent(grant);
    const target = this.usableTarget(grant);
    if (!target.hostKey) throw new TargetError(409, "the host key of the target is not pinned");
    const slot: KeySlot = grant.maintenance ? "provisioner" : "main";

    let key;

    try {
      key = await keys.open(grant.targetId, unlock, slot);
    } catch (error) {
      if (error instanceof KeyError && error.code === "wrong-unlock")
        throw new GrantError(403, "the unlock does not open the key");
      if (error instanceof KeyError && error.code === "needs-rewrap")
        throw new TargetError(409, "this target needs its key to be recovered");
      throw error;
    }

    // The derive takes a while: a disable, a retire or a recovery begin can land meanwhile. Read the target again.
    try {
      this.usableTarget(grant);
      if (keys.pendingRewraps(slot).includes(grant.targetId))
        throw new TargetError(409, "this target needs its key to be recovered");
      this.checkStillCurrent(grant);
    } catch (error) {
      key.destroy();
      throw error;
    }

    // The grant store holds the key from here, and destroys it when the grant ends. It destroys it at once if this fails.
    const publicKey = Buffer.from(key.publicBlob).toString("base64");
    const active = grants.approve(grantId, by, key, minutes);

    if (!active.maintenance) {
      await this.activate(active, target, publicKey);
      return grants.get(grantId) ?? active;
    }

    // From here the run of a maintenance grant holds the lock of the target, also after the grant ended.
    this.running.set(active.targetId, active.id);

    try {
      let config: string;

      try {
        config = (await this.activate(active, target, publicKey)).config;
      } catch (error) {
        this.endMaintenance(active.id, by, { result: "failed", detail: message(error) });
        throw error;
      }

      return await this.runMaintenance(active, config, by, options.commit);
    } finally {
      const clear = () => {
        if (this.running.get(active.targetId) === active.id) this.running.delete(active.targetId);
      };

      // A commit that passed its time limit can still write the store: the lock holds until it settles, so no new
      // change of the target starts before the store is final.
      const late = this.lateCommits.get(active.id);
      this.lateCommits.delete(active.id);
      if (late) void late.then(clear, clear);
      else clear();
    }
  }

  /**
   * Gives an active grant to its node (`POST /grants`) and returns the answer of the node. A node that cannot take it
   * ends the grant with `node-lost` and throws a `GrantError` 409.
   */
  private async activate(grant: Grant, target: Target, publicKey: string): Promise<{ socket: string; config: string }> {
    const { grants } = this.deps;
    let files: { socket: string; config: string };

    try {
      const reply = await this.nodeCall(grant.nodeId, "POST", "/grants", {
        grantId: grant.id,
        ...(grant.requestId !== undefined ? { requestId: grant.requestId } : {}),
        instanceId: grant.instanceId,
        targetId: grant.targetId,
        publicKey,
        address: target.address,
        port: target.port,
        account: target.account,
        hostKey: target.hostKey,
        endsAt: grant.endsAt,
      });
      if (!isOk(reply.status)) throw new Error(errorText(reply.body, reply.status));
      const body = isObject(reply.body) ? reply.body : {};
      files = {
        socket: typeof body.socket === "string" ? body.socket : "",
        config: typeof body.config === "string" ? body.config : "",
      };
      // The hub runs ssh with the config file of a maintenance grant: without it there is nothing to run.
      if (grant.maintenance && !files.config) throw new Error("the node gave no config file for the grant");
    } catch (error) {
      grants.endWhere((item) => item.id === grant.id, "node-lost");
      if (error instanceof GrantError) throw error;
      // The owner reads this text on the approve sheet, so the node text becomes plain words.
      const text = message(error);
      throw new GrantError(409, text === NO_WAITING_REQUEST ? STOPPED_WAITING : text);
    }

    // The grant ended while the POST was in flight: its DELETE may have reached the node before the grant existed
    // there, and the node has no timer of its own. Tell the node again.
    if (grants.get(grant.id)?.state !== "active") {
      void this.nodeCall(grant.nodeId, "DELETE", `/grants/${grant.id}`).catch((error: unknown) => {
        this.failed(grant, message(error));
      });
    }

    return files;
  }

  /**
   * The target of a grant, if a grant may use it now: a `ready` target, or a `draft` target for the test grant that the
   * hub makes (`test`). A real grant never uses a target that has not passed its test. A maintenance grant uses a
   * target in every state: a retire sets `disabled` first, and the uninstall still runs.
   */
  private usableTarget(grant: Grant): Target {
    const target = this.deps.targets.get(grant.targetId);
    if (!target) throw new TargetError(404, "no such target");
    if (grant.maintenance) return target;
    if (target.state !== "ready" && !(target.state === "draft" && grant.test))
      throw new TargetError(409, `the target is ${target.state}`);
    return target;
  }

  /**
   * Makes a pending maintenance grant for the node `local`: one action of the provisioner script on an external target.
   * Only the hub calls this, for an admin. It checks every precondition first, and it refuses a second request for the
   * same target while one is pending, active or running. The owner approves the grant with a new unlock.
   */
  requestMaintenance(input: { targetId: string; action: MaintenanceAction; toNodes?: string[]; by: string }): Grant {
    const target = this.needTarget(input.targetId);
    const maintenance = this.planMaintenance(target, input.action, input.toNodes);
    if (this.maintenanceFor(target.id)) throw new TargetError(409, MAINTENANCE_BUSY);
    const grant = this.deps.grants.request({
      nodeId: LOCAL_HOST,
      instanceId: MAINTENANCE_INSTANCE,
      targetId: target.id,
      maintenance,
    });
    const to = maintenance.toSources ?? maintenance.fromSources;
    this.maintenanceNote(
      grant,
      `event=requested by=${logToken(input.by)} from=${maintenance.fromSources.length} to=${to.length}`,
    );

    try {
      this.deps.notifyMaintenance?.(grant, target);
    } catch (error) {
      this.note(`notify failed grant=${logToken(grant.id)} failed=${logToken(message(error))}`);
    }

    return grant;
  }

  /** The maintenance grant of a target that is pending or active, or whose run is not over yet. */
  maintenanceFor(targetId: string): Grant | undefined {
    const { grants } = this.deps;
    const open = grants
      .list()
      .find((grant) => grant.maintenance !== undefined && grant.targetId === targetId && grant.state !== "ended");
    if (open) return open;
    const running = this.running.get(targetId);
    return running === undefined ? undefined : grants.get(running);
  }

  /** The target ids whose maintenance run is not over, with the grant id. The lock of `maintenanceFor`. */
  private readonly running = new Map<string, string>();

  /** The commits that passed their time limit and have not settled yet, by grant id. */
  private readonly lateCommits = new Map<string, Promise<void>>();

  /** The preconditions of a maintenance grant, and its lists. It throws the first refusal, with a plain text. */
  private planMaintenance(target: Target, action: MaintenanceAction, toNodes: string[] | undefined): Maintenance {
    const { keys, targets } = this.deps;
    if (target.managedHost !== undefined) throw new TargetError(409, "the target is a managed target");
    if (!hasProvisioner(target) || !this.hasKey(target.id, "provisioner"))
      throw new TargetError(409, "this target has no provisioner");
    const localReady = this.deps.localReady ?? (() => this.deps.client(LOCAL_HOST) !== undefined);
    if (!localReady()) throw new HttpError(501, "the hub cannot run maintenance on this system");
    const hasSsh = this.deps.hasSsh ?? (() => Bun.which("ssh") !== null);
    if (!hasSsh()) throw new TargetError(409, NO_SSH_PROGRAM);
    const local = targets.nodeAccess(LOCAL_HOST);
    if (local?.enabled !== true || !local.sourceAddress)
      throw new TargetError(409, "turn on SSH access for the node local with a source address");
    if (local.sourceAddress !== target.provisionerSource)
      throw new TargetError(
        409,
        `the source address of local changed since the provisioner was installed: run claude-rc ssh target provisioner ${target.id} --identity <file>`,
      );
    if (keys.pendingRewraps("main").includes(target.id) || keys.pendingRewraps("provisioner").includes(target.id))
      throw new TargetError(409, "this target needs its key to be recovered");
    if (!target.hostKey) throw new TargetError(409, "the host key of the target is not pinned");

    const fromNodes = [...target.nodes];
    const fromSources = targets.sourcesOf(target);

    if (action !== "sources") {
      if (toNodes !== undefined) throw new TargetError(400, "only the action sources takes a new node list");
      // `install` sends the stored list first, so the list must be one that the script takes.
      if (action === "install")
        this.needSources(fromSources, "no node of this target has access enabled with a source address");
      return { action, fromNodes, fromSources };
    }

    if (
      !Array.isArray(toNodes) ||
      toNodes.length > MAX_NODES ||
      !toNodes.every((id) => typeof id === "string" && HOST_ID_RE.test(id)) ||
      new Set(toNodes).size !== toNodes.length
    )
      throw new TargetError(400, "the new node list must be distinct host ids");
    const toSources = targets.sourcesOf({ nodes: toNodes });
    this.needSources(toSources, "no node of the new list has access enabled with a source address");
    return { action, fromNodes, toNodes: [...toNodes], fromSources, toSources };
  }

  private needSources(list: string[], empty: string): void {
    if (list.length === 0) throw new TargetError(409, empty);
    // A ruling of the owner: the script takes exact addresses and host names only, no pattern.
    if (!validSources(list))
      throw new TargetError(409, "a source address of the list is not an exact address or host name");
  }

  private hasKey(targetId: string, slot: KeySlot): boolean {
    try {
      this.deps.keys.publicLine(targetId, slot);
      return true;
    } catch (error) {
      if (error instanceof KeyError && error.code === "no-key") return false;
      throw error;
    }
  }

  /**
   * For a maintenance grant: the preconditions still hold and the lists are the ones of the request. A grant whose
   * change is out of date can never run, so it ends at once and the lock of the target clears.
   */
  private checkStillCurrent(grant: Grant): void {
    const work = grant.maintenance;
    if (!work) return;

    try {
      const now = this.planMaintenance(this.needTarget(grant.targetId), work.action, work.toNodes);
      // An uninstall removes the line whatever its list, so only the other actions care about the sources.
      if (
        (work.action !== "uninstall" && !sameList(now.fromSources, work.fromSources)) ||
        !sameList(now.toSources ?? [], work.toSources ?? []) ||
        (work.action === "sources" && !sameList(now.fromNodes, work.fromNodes))
      )
        throw new TargetError(409, OUT_OF_DATE);
    } catch (error) {
      if (this.deps.grants.get(grant.id)?.state === "pending") {
        this.deps.grants.setResult(grant.id, "failed", message(error));
        this.deps.grants.deny(grant.id, "system");
      }

      throw error;
    }
  }

  /** The commands of an action. `status` runs after the action as a check. `uninstall` removes the script, so none. */
  private stepsOf(work: Maintenance): Step[] {
    const sources = (list: string[]): Step => ({
      command: { kind: "sources", list },
      check: (answer) => answer.kind === "sources" && sameList(answer.list, list),
      wrong: "the script did not store the new list",
    });
    const status = (list: string[]): Step => ({
      command: { kind: "status" },
      check: (answer) => answer.kind === "status" && answer.present && sameList(answer.list, list),
      wrong: "the key line on the target does not hold the list after the run",
    });

    if (work.action === "uninstall")
      return [
        {
          command: { kind: "uninstall" },
          check: (answer) => answer.kind === "uninstall",
          wrong: "the script did not remove the key lines",
        },
      ];
    if (work.action === "sources") return [sources(work.toSources ?? []), status(work.toSources ?? [])];
    return [
      sources(work.fromSources),
      {
        command: { kind: "on" },
        check: (answer) => answer.kind === "on" && sameList(answer.list, work.fromSources),
        wrong: "the script did not put the key line back",
      },
      status(work.fromSources),
    ];
  }

  /**
   * Runs the steps of an active maintenance grant, one `ssh` child process each, then `commit`, and ends the grant.
   * Before each step the grant must still be active: a grant that ended (an expiry, a revoke) records `failed`, skips
   * the other steps and is not finished again. A failed `sources`, or a `commit` that throws, puts the old list back in
   * the same grant, as a best effort. `changed` tells that the target can hold a change that the hub did not store.
   * The `finally` ends the grant on every path, a crash too.
   */
  private async runMaintenance(
    grant: Grant,
    config: string,
    by: string,
    commit: MaintenanceCommit | undefined,
  ): Promise<Grant> {
    let outcome: Outcome = { result: "failed", detail: "the run stopped", changed: false };
    let commitError: { error: unknown } | undefined;

    try {
      if (grant.maintenance) outcome = await this.runSteps(grant, grant.maintenance, config);

      if (outcome.result === "done" && commit) {
        try {
          await this.boundedCommit(commit, this.deps.grants.get(grant.id) ?? grant, grant.id);
          this.maintenanceNote(grant, "event=committed");
        } catch (error) {
          commitError = { error };
          this.maintenanceNote(grant, `event=commit-failed error=${errorKind(error)}`);
          const restored = await this.restore(grant, config);
          outcome = this.failure(`the change was not stored: ${message(error)}`, !restored.ok, restored);
        }
      }
    } finally {
      this.endMaintenance(grant.id, by, outcome);
    }

    if (commitError) throw commitError.error;
    return this.deps.grants.get(grant.id) ?? grant;
  }

  /**
   * Runs `commit` with a time limit, so that a hung commit cannot hold the lock of the target and the approve call for
   * ever. At the limit the signal aborts and the call throws `COMMIT_TIMEOUT_TEXT`. A late end of `commit` is ignored.
   */
  private async boundedCommit(commit: MaintenanceCommit, grant: Grant, grantId: string): Promise<void> {
    const timers = this.deps.timers ?? realTimers;
    const controller = new AbortController();
    let handle: unknown;

    const limit = new Promise<never>((_resolve, reject) => {
      handle = timers.setTimeout(() => {
        controller.abort();
        this.lateCommits.set(
          grantId,
          work.then(
            () => {},
            () => {},
          ),
        );
        reject(new NodeError(COMMIT_TIMEOUT_TEXT));
      }, this.deps.commitTimeoutMs ?? COMMIT_TIMEOUT_MS);
    });
    const work = commit(grant, controller.signal);
    // A commit that fails after the limit has no one to tell.
    work.catch(() => {});

    try {
      await Promise.race([work, limit]);
    } finally {
      timers.clearTimeout(handle);
    }
  }

  private async runSteps(grant: Grant, work: Maintenance, config: string): Promise<Outcome> {
    // A step that changes the target finished: a failure after it leaves the target changed, unless the restore works.
    let changed = false;

    for (const step of this.stepsOf(work)) {
      if (this.deps.grants.get(grant.id)?.state !== "active")
        return this.failure("the grant ended before the run was over", changed);

      // From here the target can change: a revoke or an expiry is no longer the same as a deny.
      this.markStarted(grant.id);
      const run = await this.runStep(grant, config, step.command);

      if (run.answer === undefined || !step.check(run.answer)) {
        const why = run.answer === undefined ? (run.error ?? "the run failed") : step.wrong;
        // A changing step that failed can still have written: a timeout, a lost connection or a wrong answer can come
        // after the write. Only a refusal of the script itself says that it wrote nothing.
        const refused = run.answer === undefined && run.code !== undefined && NOTHING_WRITTEN_CODES.has(run.code);
        const maybe = changed || (step.command.kind !== "status" && !refused);
        const restored = await this.restore(grant, config);
        return this.failure(why, restored.attempted ? !restored.ok && maybe : maybe, restored);
      }

      if (step.command.kind !== "status") changed = true;
    }

    return { result: "done", changed };
  }

  private markStarted(grantId: string): void {
    try {
      this.deps.grants.markStarted(grantId);
    } catch (error) {
      this.note(`maintenance grant=${logToken(grantId)} start not recorded failed=${errorKind(error)}`);
    }
  }

  /** A failed outcome. The fixed sentences come first, because the detail is cut to 200 characters. */
  private failure(why: string, changed: boolean, restored?: Restore): Outcome {
    const parts = [
      ...(changed ? [CHANGED_TEXT] : []),
      ...(restored?.attempted && !restored.ok ? [RESTORE_FAILED_TEXT] : []),
      why,
      ...(restored?.error ? [`the restore: ${restored.error}`] : []),
    ];
    return { result: "failed", detail: parts.join(". "), changed };
  }

  /** Records the result and ends the grant if it is still active. It never throws. */
  private endMaintenance(grantId: string, by: string, outcome: Outcome | { result: "failed"; detail: string }): void {
    const { grants } = this.deps;

    try {
      grants.setResult(grantId, outcome.result, outcome.detail, "changed" in outcome ? outcome.changed : false);
    } catch (error) {
      this.note(`maintenance grant=${logToken(grantId)} result not recorded failed=${logToken(message(error))}`);
    }

    try {
      if (grants.get(grantId)?.state === "active") grants.finish(grantId, by);
    } catch {
      // The run is over in every case: `done` is the end reason, and the result says how it went.
      grants.endWhere((item) => item.id === grantId, "done");
    }
  }

  /** A failed change of the list: the old list goes back on the target, in the same grant. Best effort. */
  private async restore(grant: Grant, config: string): Promise<Restore> {
    const work = grant.maintenance;
    if (work?.action !== "sources" || !validSources(work.fromSources)) return { attempted: false, ok: false };
    if (this.deps.grants.get(grant.id)?.state !== "active") return { attempted: false, ok: false };
    const run = await this.runStep(grant, config, { kind: "sources", list: work.fromSources });
    const ok = run.answer?.kind === "sources" && sameList(run.answer.list, work.fromSources);
    // The audit line holds a fixed word and the exit code only: the text of ssh can hold an address.
    this.maintenanceNote(grant, ok ? "event=restored" : `event=restore-failed code=${run.code ?? "none"}`);
    if (ok) return { attempted: true, ok };
    return { attempted: true, ok, error: run.error ?? "the script gave another answer" };
  }

  /**
   * One `ssh` child process. It never throws: a failure is the `error` text. The audit line names the command word,
   * the exit code and the answer word only.
   */
  private async runStep(
    grant: Grant,
    config: string,
    command: ProvisionerCommand,
  ): Promise<{ answer?: ProvisionerAnswer; code?: number; error?: string }> {
    const run = this.deps.runSsh ?? defaultRunner;
    const seen: { code?: number } = {};

    const runner: SshRunner = async (...args) => {
      const reply = await run(...args);
      seen.code = reply.code;
      return reply;
    };

    try {
      const answer = await runProvisioner(runner, config, grant.targetId, formatCommand(command));
      this.maintenanceNote(
        grant,
        `event=run command=${command.kind} code=${seen.code ?? "none"} answer=${answer.kind}`,
      );
      return { answer, ...seen };
    } catch (error) {
      this.maintenanceNote(grant, `event=run command=${command.kind} code=${seen.code ?? "none"} answer=none`);
      return { ...seen, error: message(error) };
    }
  }

  private maintenanceNote(grant: Grant, text: string): void {
    this.note(
      `maintenance grant=${logToken(grant.id)} target=${logToken(grant.targetId)} action=${grant.maintenance?.action ?? "none"} ${text}`,
    );
  }

  /** Ends an active grant. The node is told by `onGrantEnd`. */
  revoke(grantId: string, by: string): Promise<Grant> {
    return Promise.resolve().then(() => this.deps.grants.revoke(grantId, by));
  }

  /** Asks a node to read the host keys of the target. The keys are not stored: the admin checks the fingerprints first. */
  async scanHostKey(targetId: string, hostId: string): Promise<HostKeyLine[]> {
    const target = this.needTarget(targetId);
    if (!target.nodes.includes(hostId)) throw new TargetError(409, "the node is not listed for this target");
    const reply = await this.nodeReply(
      hostId,
      "POST",
      "/scan",
      { address: target.address, port: target.port },
      SCAN_TIMEOUT_MS,
    );
    return keysOf(reply.body);
  }

  /** Reads the host key of a managed target from its own node and pins it. */
  async pinManaged(targetId: string): Promise<HostKeyLine[]> {
    const target = this.needManaged(targetId);
    const reply = await this.nodeReply(target.managedHost, "GET", "/hostkey");
    const found = keysOf(reply.body);
    if (found.length === 0) throw new NodeError("the node returned no host key");
    await this.deps.targets.setHostKey(targetId, found[0].line);
    return found;
  }

  /**
   * Puts the key line of the target into the `authorized_keys` of the account, through the node that is the target.
   * With `nodes`, the line holds the sources of that proposed list instead of the stored list, so that a change of the
   * list can be installed before it is stored.
   */
  async authorizeManaged(targetId: string, nodes?: string[]): Promise<void> {
    const target = this.needManaged(targetId);
    const { keys, targets } = this.deps;
    const sources = targets.sourcesOf(nodes === undefined ? target : { nodes });
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");
    const line = authorizedKeysLine(keys.publicLine(targetId), sources, target.systemType);
    const reply = await this.nodeReply(
      target.managedHost,
      "POST",
      "/authorize",
      {
        account: target.account,
        systemType: target.systemType,
        line,
        ...(target.keyFile !== undefined ? { keyFile: target.keyFile } : {}),
      },
      SCRIPT_TIMEOUT_MS,
    );

    // An old node ignores the key file and writes `authorized_keys`. It answers without the name, so the install
    // would look fine. The node must name the file back.
    if (target.keyFile !== undefined) {
      const answered = isObject(reply.body) ? reply.body.keyFile : undefined;
      if (answered !== target.keyFile)
        throw new NodeError("the node does not know key files: update the node first, then install again");
    }
  }

  /**
   * Asks the node that is the target to remove the key line of the target. The line is found by key blob and comment.
   * Call it before the key is deleted. It never throws: a node that cannot be reached, or a script that fails, is `failed`
   * with a short text. A target without a key has no line.
   */
  async deauthorizeManaged(targetId: string): Promise<{ line: "removed" | "not-found" | "failed"; detail?: string }> {
    let target: Target & { managedHost: string };
    let blob: string | undefined;

    try {
      target = this.needManaged(targetId);

      try {
        blob = this.deps.keys.publicLine(targetId).split(" ")[1];
      } catch (error) {
        if (!(error instanceof KeyError && error.code === "no-key")) throw error;
        return { line: "not-found" };
      }

      if (!blob) return failed("the public key has no blob");
      const reply = await this.nodeReply(
        target.managedHost,
        "POST",
        "/deauthorize",
        {
          account: target.account,
          systemType: target.systemType,
          key: blob,
          id: targetId,
          ...(target.keyFile !== undefined ? { keyFile: target.keyFile } : {}),
        },
        DEAUTHORIZE_TIMEOUT_MS,
      );
      const result = isObject(reply.body) ? reply.body.result : undefined;
      if (result === "removed" || result === "not-found") return { line: result };
      return failed("the node gave no result");
    } catch (error) {
      return failed(message(error));
    }
  }

  /**
   * Opens a one-minute grant for the instance `test`, runs `ssh true` through it, and ends the grant. A probe that
   * exits 0 makes the target `ready`. A wrong unlock is a 403, and no grant stays pending.
   */
  async test(
    targetId: string,
    hostId: string,
    by: string,
    unlock: UnlockSecret,
  ): Promise<{ ok: boolean; error?: string }> {
    const { grants, targets } = this.deps;
    const target = this.needTarget(targetId);
    if (!target.nodes.includes(hostId)) throw new TargetError(409, "the node is not listed for this target");
    const grant = grants.request({ nodeId: hostId, instanceId: "test", targetId, test: true });

    try {
      await this.approve(grant.id, by, unlock);
    } catch (error) {
      const now = grants.get(grant.id);

      if (now?.state === "pending") {
        grants.deny(grant.id, by);
        throw error;
      }

      // The grant has ended already: the node did not take it.
      if (error instanceof GrantError || error instanceof TargetError) return { ok: false, error: error.message };
      throw error;
    }

    try {
      const reply = await this.nodeCall(hostId, "POST", `/grants/${grant.id}/probe`, undefined, PROBE_TIMEOUT_MS);
      if (!isOk(reply.status)) return { ok: false, error: errorText(reply.body, reply.status) };
      const { code, stderr } = isObject(reply.body) ? reply.body : { code: undefined, stderr: undefined };

      if (code === 0) {
        await targets.setState(targetId, "ready");
        // The nodes list only ready targets: tell them that this one can be requested now.
        await this.pushAll(target.nodes);
        return { ok: true };
      }

      const text = typeof stderr === "string" ? stderr.trim() : "";
      return { ok: false, error: text || `ssh exited with code ${typeof code === "number" ? code : "unknown"}` };
    } catch (error) {
      return { ok: false, error: message(error) };
    } finally {
      if (grants.get(grant.id)?.state === "active") grants.revoke(grant.id, by);
    }
  }

  /** Sends the id, account and address of each `ready` target that lists the host. A draft is not requestable. */
  async pushTargets(hostId: string): Promise<void> {
    const targets = this.deps.targets
      .list()
      .filter((target) => target.nodes.includes(hostId) && target.state === "ready")
      .map((target) => ({ id: target.id, account: target.account, address: target.address }));
    const reply = await this.nodeCall(hostId, "PUT", "/targets", { targets });
    if (!isOk(reply.status)) throw new Error(errorText(reply.body, reply.status));
  }

  /** The `onLeavePending` hook of the grant store. A test grant never had a notification. It never throws. */
  onGrantLeavePending(grant: Grant): void {
    if (grant.test) return;

    try {
      this.deps.notifyClose?.(grant);
    } catch (error) {
      this.note(`notify close failed grant=${logToken(grant.id)} failed=${logToken(message(error))}`);
    }
  }

  /**
   * The `onEnd` hook of the grant store. It never throws and never rejects: the grant store calls it without a guard,
   * and an error here would leave the other grants of `endWhere` active. The node call runs in the background.
   */
  onGrantEnd(grant: Grant): void {
    try {
      let call: Promise<{ status: number; body: unknown }> | undefined;

      if (grant.state === "ended" && grant.approvedAt === undefined) {
        if (grant.requestId === undefined) return;
        call = this.nodeCall(grant.nodeId, "POST", `/requests/${grant.requestId}/reject`, {
          reason: `the grant ended: ${grant.endReason ?? "ended"}`,
        });
      } else if (grant.approvedAt !== undefined) {
        call = this.nodeCall(grant.nodeId, "DELETE", `/grants/${grant.id}`);
      }

      void call?.then(
        (reply) => {
          if (!isOk(reply.status) && reply.status !== 404 && reply.status !== 501)
            this.failed(grant, errorText(reply.body, reply.status));
        },
        (error: unknown) => {
          this.failed(grant, message(error));
        },
      );
    } catch (error) {
      this.failed(grant, message(error));
    }
  }

  /** Pushes the targets to each node. A node that cannot be reached is audited: the change itself stands. */
  private async pushAll(hostIds: string[]): Promise<void> {
    for (const hostId of new Set(hostIds)) {
      try {
        await this.pushTargets(hostId);
      } catch (error) {
        this.note(`node=${logToken(hostId)} push failed=${logToken(message(error))}`);
      }
    }
  }

  /** The node stopped the control socket of an instance (it opted out, or it was deleted): its grants end. */
  private onInstanceOff(hostId: string, data: unknown): void {
    if (!isObject(data) || typeof data.instanceId !== "string") {
      this.note(`dropped instance-off node=${logToken(hostId)} bad event`);
      return;
    }

    const { instanceId } = data;
    this.deps.grants.endWhere((grant) => grant.nodeId === hostId && grant.instanceId === instanceId, "revoked");
  }

  private failed(grant: Grant, why: string): void {
    this.note(`grant=${logToken(grant.id)} node=${logToken(grant.nodeId)} node call failed=${logToken(why)}`);
  }

  private async onRequest(hostId: string, data: unknown): Promise<void> {
    if (
      !isObject(data) ||
      typeof data.requestId !== "string" ||
      typeof data.instanceId !== "string" ||
      typeof data.targetId !== "string"
    ) {
      this.note(`dropped request node=${logToken(hostId)} bad event`);
      return;
    }

    const { requestId, instanceId, targetId } = data;
    const target = this.deps.targets.get(targetId);

    const refuse = async (why: string) => {
      this.note(`dropped request node=${logToken(hostId)} target=${logToken(targetId)} ${why}`);
      const reply = await this.nodeCall(hostId, "POST", `/requests/${encodeURIComponent(requestId)}/reject`, {
        reason: why,
      });
      if (!isOk(reply.status))
        this.note(`reject failed node=${logToken(hostId)} failed=${logToken(errorText(reply.body, reply.status))}`);
    };

    if (!target) return refuse("no such target");
    if (!target.nodes.includes(hostId)) return refuse("the node is not listed for the target");
    // Only a target that passed its test can be requested. A draft is for the test grant of the hub alone.
    if (target.state !== "ready") return refuse(`the target is ${target.state}`);

    let grant: Grant;

    try {
      grant = this.deps.grants.request({
        nodeId: hostId,
        instanceId,
        targetId,
        requestId,
        ...(typeof data.minutes === "number" ? { minutes: data.minutes } : {}),
        ...(typeof data.reason === "string" ? { reason: data.reason.slice(0, MAX_REASON) } : {}),
      });
    } catch (error) {
      return refuse(message(error));
    }

    try {
      this.deps.notify?.(grant, target);
    } catch (error) {
      this.note(`notify failed grant=${logToken(grant.id)} failed=${logToken(message(error))}`);
    }
  }

  private async onSign(hostId: string, data: unknown): Promise<void> {
    if (!isObject(data) || typeof data.signId !== "string") {
      this.note(`dropped sign node=${logToken(hostId)} bad event`);
      return;
    }

    const signId = data.signId;
    let body: { signId: string; signature: string } | { signId: string; error: string };

    try {
      const { grantId, keyBlob, data: payload } = data;
      if (typeof grantId !== "string" || typeof keyBlob !== "string" || typeof payload !== "string")
        throw new GrantError(400, "the sign request is not valid");
      if (keyBlob.length > MAX_BLOB_CHARS || payload.length > MAX_BLOB_CHARS)
        throw new GrantError(400, "the sign request is too big");
      const grant = this.deps.grants.get(grantId);
      if (grant && grant.nodeId !== hostId) throw new GrantError(403, "the grant belongs to another node");
      const signature = this.deps.grants.sign(
        grantId,
        new Uint8Array(Buffer.from(keyBlob, "base64")),
        new Uint8Array(Buffer.from(payload, "base64")),
      );
      body = { signId, signature: Buffer.from(signature).toString("base64") };
    } catch (error) {
      body = { signId, error: error instanceof GrantError ? error.message : "signing failed" };
    }

    const reply = await this.nodeCall(hostId, "POST", "/sign-result", body);
    if (!isOk(reply.status))
      this.note(`sign-result node=${logToken(hostId)} failed=${logToken(errorText(reply.body, reply.status))}`);
  }

  private needTarget(targetId: string): Target {
    const target = this.deps.targets.get(targetId);
    if (!target) throw new TargetError(404, "no such target");
    return target;
  }

  private needManaged(targetId: string): Target & { managedHost: string } {
    const target = this.needTarget(targetId);
    if (target.managedHost === undefined) throw new TargetError(409, "the target is not a managed target");
    return { ...target, managedHost: target.managedHost };
  }

  /** A call that must succeed: a node that cannot be reached, or that answers with an error, is a `NodeError`. */
  private async nodeReply(
    hostId: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    json?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; body: unknown }> {
    let reply: { status: number; body: unknown };

    try {
      reply = await this.nodeCall(hostId, method, path, json, timeoutMs);
    } catch (error) {
      throw new NodeError(message(error));
    }

    if (!isOk(reply.status)) throw new NodeError(errorText(reply.body, reply.status));
    return reply;
  }

  /** One call to a node route below `/api/ssh`. It rejects when the node is not known or cannot be reached. */
  private nodeCall(
    hostId: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    json?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; body: unknown }> {
    const client = this.deps.client(hostId);
    if (!client) return Promise.reject(new Error(`node ${hostId} is not connected`));
    return client.call(method, `${NODE_API}${path}`, {
      ...(json !== undefined ? { json } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  private note(text: string): void {
    this.deps.audit(`audit ssh ${text}`);
  }
}

/** A failed removal. The detail is one short line of text. */
function failed(text: string): { line: "failed"; detail: string } {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return { line: "failed", detail: detail || "the removal failed" };
}

/** The `{ line, fingerprint }` entries of the answer of `/scan` and `/hostkey`. */
function keysOf(body: unknown): HostKeyLine[] {
  const list = isObject(body) && Array.isArray(body.keys) ? (body.keys as unknown[]) : [];
  const found: HostKeyLine[] = [];

  for (const item of list) {
    if (isObject(item) && typeof item.line === "string" && typeof item.fingerprint === "string")
      found.push({ line: item.line, fingerprint: item.fingerprint });
  }

  return found;
}
