import { randomUUID } from "node:crypto";
import { realTimers } from "./changesource";
import type { Timers } from "./changesource";
import { logToken } from "./roles";
import type { UnlockedKey } from "./sshkeystore";

// Grant state machine for SSH delegation. A grant is a request from a node to use the key of one target for a while.
// It starts `pending`. An admin approves it with an unlocked key (`active`), or denies it. A grant ends by its own
// timer, by a revoke, or when the hub ends it for a reason of its own (`endWhere`). A grant never holds a key before
// approve. Every end path destroys the key first and only then calls `onEnd`.
// Grants live in memory only: a hub restart ends them all, so nothing is saved. A pending grant that nobody answers
// expires after 10 minutes. The last 200 ended grants stay in the list, so that the UI can show what just happened.
// Every transition writes one audit line. A sign line holds the key fingerprint and never the data that was signed.

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 480;
const PENDING_MINUTES = 10;
const TEST_MINUTES = 1;
const MAINTENANCE_MINUTES = 1;
const MAX_DETAIL = 200;
const MAX_ENDED = 200;
const MINUTE_MS = 60_000;

export type GrantState = "pending" | "active" | "ended";
export type EndReason = "expired" | "revoked" | "denied" | "node-lost" | "target-disabled" | "hub-restart" | "done";

/** What a maintenance grant does on the target with the provisioner key. */
export type MaintenanceAction = "install" | "sources" | "uninstall";

/**
 * The work of a maintenance grant. Only the hub sets it (`SshService.requestMaintenance`), never a node event. The
 * lists are the node lists and source lists before and after, as the hub computed them at the request.
 */
export interface Maintenance {
  action: MaintenanceAction;
  fromNodes: string[];
  toNodes?: string[];
  fromSources: string[];
  toSources?: string[];
  result?: "done" | "failed";
  /** One short line of text. */
  detail?: string;
}

export interface Grant {
  id: string;
  requestId?: string;
  nodeId: string;
  instanceId: string;
  targetId: string;
  minutes: number;
  reason?: string;
  test: boolean;
  state: GrantState;
  requestedAt: number;
  approvedAt?: number;
  endsAt?: number;
  approvedBy?: string;
  endReason?: EndReason;
  maintenance?: Maintenance;
}

/** A copy of a grant that shares no array or object with the store. */
function copy(grant: Grant): Grant {
  const result = { ...grant };

  if (grant.maintenance) {
    const work = grant.maintenance;
    result.maintenance = {
      ...work,
      fromNodes: [...work.fromNodes],
      fromSources: [...work.fromSources],
      ...(work.toNodes ? { toNodes: [...work.toNodes] } : {}),
      ...(work.toSources ? { toSources: [...work.toSources] } : {}),
    };
  }

  return result;
}

/** One line of at most 200 characters, with no control characters. */
function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, MAX_DETAIL);
}

/** `400`: bad input. `404`: no such grant. `409`: the grant is not in the state that the call needs. `403`: the grant does not allow this use. */
export class GrantError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 403,
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

interface Options {
  now?: () => number;
  timers?: Timers;
  audit: (line: string) => void;
  onEnd: (grant: Grant) => void;
  /** Called once when a grant leaves `pending`: approved, denied, expired or ended by the hub. It never fails a call. */
  onLeavePending?: (grant: Grant) => void;
  defaultMinutes?: number;
  maxMinutes?: number;
  pendingMinutes?: number;
}

export class GrantStore {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly audit: (line: string) => void;
  private readonly onEnd: (grant: Grant) => void;
  private readonly onLeavePending: ((grant: Grant) => void) | undefined;
  private readonly defaultMinutes: number;
  private readonly maxMinutes: number;
  private readonly pendingMinutes: number;
  private readonly grants = new Map<string, Grant>();
  private readonly keys = new Map<string, UnlockedKey>();
  private readonly handles = new Map<string, unknown>();

  constructor(options: Options) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.audit = options.audit;
    this.onEnd = options.onEnd;
    this.onLeavePending = options.onLeavePending;
    this.defaultMinutes = options.defaultMinutes ?? DEFAULT_MINUTES;
    this.maxMinutes = options.maxMinutes ?? MAX_MINUTES;
    this.pendingMinutes = options.pendingMinutes ?? PENDING_MINUTES;
  }

  /**
   * A new pending grant. A test grant is always 1 minute, and so is a maintenance grant. Only the hub passes
   * `maintenance`: a grant is never both a test grant and a maintenance grant.
   */
  request(input: {
    nodeId: string;
    instanceId: string;
    targetId: string;
    requestId?: string;
    minutes?: number;
    reason?: string;
    test?: boolean;
    maintenance?: Maintenance;
  }): Grant {
    const test = input.test === true;
    const maintenance = input.maintenance;
    if (test && maintenance) throw new GrantError(400, "a grant is a test grant or a maintenance grant, not both");
    const grant: Grant = {
      id: randomUUID(),
      nodeId: input.nodeId,
      instanceId: input.instanceId,
      targetId: input.targetId,
      minutes: test
        ? TEST_MINUTES
        : maintenance
          ? MAINTENANCE_MINUTES
          : this.clamp(input.minutes ?? this.defaultMinutes),
      test,
      state: "pending",
      requestedAt: this.now(),
    };
    if (input.requestId !== undefined) grant.requestId = input.requestId;
    if (input.reason !== undefined) grant.reason = input.reason;
    if (maintenance) grant.maintenance = copy({ ...grant, maintenance }).maintenance;

    this.grants.set(grant.id, grant);
    this.handles.set(
      grant.id,
      this.timers.setTimeout(() => this.end(grant, "expired", "system"), this.pendingMinutes * MINUTE_MS),
    );
    this.line(grant, "requested", grant.nodeId);
    return copy(grant);
  }

  /**
   * Gives the key to a pending grant and starts its clock. `minutes` can set a shorter or longer time than the
   * request, up to the maximum. A test grant and a maintenance grant ignore `minutes`. A call that fails destroys the key it was given, unless it is the key of the grant.
   */
  approve(id: string, by: string, key: UnlockedKey, minutes?: number): Grant {
    try {
      const grant = this.need(id);
      if (grant.state !== "pending") throw new GrantError(409, `grant is ${grant.state}`);
      if (minutes !== undefined && !grant.test && !grant.maintenance) grant.minutes = this.clamp(minutes);

      this.clear(id);
      const at = this.now();
      grant.state = "active";
      grant.approvedAt = at;
      grant.approvedBy = by;
      grant.endsAt = at + grant.minutes * MINUTE_MS;
      this.keys.set(id, key);
      this.handles.set(
        id,
        this.timers.setTimeout(() => this.end(grant, "expired", "system"), grant.minutes * MINUTE_MS),
      );
      this.line(grant, "approved", by);
      this.leftPending(grant);
      return copy(grant);
    } catch (error) {
      if (this.keys.get(id) !== key) key.destroy();
      throw error;
    }
  }

  deny(id: string, by: string): Grant {
    const grant = this.need(id);
    if (grant.state !== "pending") throw new GrantError(409, `grant is ${grant.state}`);
    return this.end(grant, "denied", by);
  }

  revoke(id: string, by: string): Grant {
    const grant = this.need(id);
    if (grant.state !== "active") throw new GrantError(409, `grant is ${grant.state}`);
    return this.end(grant, "revoked", by);
  }

  /** Records the result of the run of a maintenance grant, in any state. The detail is cut to one short line. */
  setResult(id: string, result: "done" | "failed", detail?: string): void {
    const grant = this.need(id);
    if (!grant.maintenance) throw new GrantError(409, "the grant is not a maintenance grant");
    grant.maintenance.result = result;
    if (detail === undefined) delete grant.maintenance.detail;
    else grant.maintenance.detail = oneLine(detail);
  }

  /** Ends an active maintenance grant after its run, with the reason `done`. */
  finish(id: string, by: string): Grant {
    const grant = this.need(id);
    if (!grant.maintenance) throw new GrantError(409, "the grant is not a maintenance grant");
    if (grant.state !== "active") throw new GrantError(409, `grant is ${grant.state}`);
    return this.end(grant, "done", by);
  }

  /** Ends every pending or active grant that matches. The audit event is the reason. */
  endWhere(match: (grant: Grant) => boolean, reason: EndReason): Grant[] {
    const result: Grant[] = [];

    for (const grant of [...this.grants.values()]) {
      if (grant.state === "ended" || !match(copy(grant))) continue;
      result.push(this.end(grant, reason, "system"));
    }

    return result;
  }

  /** Signs with the key of an active grant. The key blob must be the public key of that grant. */
  sign(id: string, keyBlob: Uint8Array, data: Uint8Array): Uint8Array {
    const grant = this.need(id);

    if (grant.state === "active" && grant.endsAt !== undefined && this.now() >= grant.endsAt) {
      this.end(grant, "expired", "system");
    }

    const key = this.keys.get(id);
    if (grant.state !== "active" || !key) throw new GrantError(403, `grant is ${grant.state}`);
    if (!Buffer.from(key.publicBlob).equals(Buffer.from(keyBlob)))
      throw new GrantError(403, "key is not the key of the grant");

    const signature = key.sign(data);
    this.line(grant, "signed", grant.nodeId, `key=${logToken(key.fingerprint)}`);
    return signature;
  }

  get(id: string): Grant | undefined {
    const grant = this.grants.get(id);
    return grant && copy(grant);
  }

  list(): Grant[] {
    return [...this.grants.values()].map((grant) => copy(grant));
  }

  private need(id: string): Grant {
    const grant = this.grants.get(id);
    if (!grant) throw new GrantError(404, "no such grant");
    return grant;
  }

  private clamp(minutes: number): number {
    if (!Number.isFinite(minutes) || minutes < 1) throw new GrantError(400, "minutes must be at least 1");
    return Math.min(Math.floor(minutes), this.maxMinutes);
  }

  private clear(id: string): void {
    if (!this.handles.has(id)) return;
    this.timers.clearTimeout(this.handles.get(id));
    this.handles.delete(id);
  }

  /** The one end path: stop the timer, destroy the key, mark the grant, audit, and only then tell the owner. */
  private end(grant: Grant, reason: EndReason, by: string): Grant {
    this.clear(grant.id);
    const wasPending = grant.state === "pending";
    const key = this.keys.get(grant.id);
    this.keys.delete(grant.id);

    try {
      key?.destroy();
    } finally {
      grant.state = "ended";
      grant.endReason = reason;
      this.line(grant, reason, by);
      this.prune();
      if (wasPending) this.leftPending(grant);
      this.onEnd(copy(grant));
    }

    return copy(grant);
  }

  /** A grant left `pending` (approve or any end path). A throw in the hook is audited and never fails the call. */
  private leftPending(grant: Grant): void {
    try {
      this.onLeavePending?.(copy(grant));
    } catch {
      this.audit(`audit ssh grant=${logToken(grant.id)} event=leave-pending-hook-failed`);
    }
  }

  private prune(): void {
    const ended = [...this.grants.values()].filter((grant) => grant.state === "ended");
    for (const grant of ended.slice(0, Math.max(0, ended.length - MAX_ENDED))) this.grants.delete(grant.id);
  }

  private line(grant: Grant, event: string, by: string, extra?: string): void {
    const action = grant.maintenance ? ` action=${grant.maintenance.action}` : "";
    const base = `audit ssh grant=${logToken(grant.id)} event=${event} node=${logToken(grant.nodeId)} target=${logToken(grant.targetId)}${action} by=${logToken(by)}`;
    this.audit(extra ? `${base} ${extra}` : base);
  }
}
