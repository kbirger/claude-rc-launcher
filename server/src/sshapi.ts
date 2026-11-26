import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HOST_ID_RE, LOCAL_HOST } from "./hostid";
import { HttpError } from "./instances";
import { isObject, readObject } from "./requests";
import { logToken } from "./roles";
import { keyFingerprint } from "./sshagentproto";
import { GrantError } from "./sshgrants";
import type { Grant, GrantStore, Maintenance } from "./sshgrants";
import { KeyError } from "./sshkeystore";
import type { KeySlot, SshKeyStore, UnlockSecret } from "./sshkeystore";
import { provisionScript } from "./sshprovision";
import { linuxInstallScript } from "./sshprovisioner";
import { MAINTENANCE_BUSY, NodeError } from "./sshservice";
import type { MaintenanceCommit, SshService } from "./sshservice";
import {
  authorizedKeysLine,
  hasProvisioner,
  HOST_KEY_RE,
  installNotes,
  isSystemType,
  keyFileProblem,
  MAX_NODES,
  SCRIPT_PATH_RE,
  TargetError,
} from "./sshtargets";
import type { Target, TargetState, TargetStore } from "./sshtargets";
import { newRecovery } from "./sshwrap";
import type { User } from "./userauth";

// The routes of SSH delegation on the hub, mounted at `/ssh` of the browser API and of the CLI API. They set up the
// unlock method, manage targets and the access of nodes, install and pin keys, and approve, deny and revoke grants.
// Until `POST /setup` has run, every route but `GET /status` and `POST /setup` answers 409. An unlock in a body is
// `{ method, secret }` with the secret in base64url. No route returns a secret, a private key or an unlock. The
// recovery code is returned once, by `POST /setup`. Every write writes one audit line with the user and the role.
// The minimum role of each route is in `roles.ts`.
//
// An external target with a provisioner (a provisioner key and an installed script) changes through a maintenance grant:
// a PATCH with `nodes`, a DELETE and `POST /targets/:id/reinstall` answer `202 { maintenance: <grant> }` and change
// nothing yet. The owner approves that grant with `POST /grants/:id/approve` and a new unlock of the provisioner key.
// Only then does the hub run the script on the target, and only after a good run does it store the change (the new
// node list, or the delete of the target). The answer of that approve is the grant, with the extra fields below:
// - `sources`: 200 `{ ...grant, target, pushed, lineUpdated: true }`, or 502 when the run failed (the list stays).
// - `uninstall`: 200 `{ ...grant, retired: <the retire answer> }`. A failed run still retires, with `line: "failed"`.
// - `install`: 200 with the grant, or 502 when the run failed.
// A deny or an expiry of the grant changes nothing. A pending grant lives in memory only: after a restart of the hub it
// is gone, the node list is as it was, and a retire leaves the target `disabled` with both keys. The owner then sends
// the DELETE again, or `DELETE /targets/:id?cleanup=none` (the retire without the run, `line: "manual"`).

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SECRET_CHARS = 4096;
const DEFAULT_PORT = 22;

export interface SshApiOptions {
  service: SshService;
  keys: SshKeyStore;
  targets: TargetStore;
  grants: GrantStore;
  /** The host name of the URL of a remote node, or `undefined` for `local` and for an id that is not a host. */
  hostAddress: (hostId: string) => string | undefined;
  /** The ids of all hosts, for the node list of `GET /status`. */
  hostIds: () => string[];
  /** The name of the user of the request. */
  user: (context: Context) => string;
  /** Where the audit lines go. Default: the console. */
  audit?: (line: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The work of a maintenance grant: the action, the lists as plain strings and the result. No key, no secret. */
function maintenanceProjection(work: Maintenance) {
  return {
    action: work.action,
    fromNodes: [...work.fromNodes],
    ...(work.toNodes ? { toNodes: [...work.toNodes] } : {}),
    fromSources: [...work.fromSources],
    ...(work.toSources ? { toSources: [...work.toSources] } : {}),
    ...(work.result !== undefined ? { result: work.result } : {}),
    ...(work.detail !== undefined ? { detail: work.detail } : {}),
    ...(work.changed !== undefined ? { changed: work.changed } : {}),
  };
}

/** The grant without anything that the page does not need. */
function projection(grant: Grant) {
  return {
    id: grant.id,
    nodeId: grant.nodeId,
    instanceId: grant.instanceId,
    targetId: grant.targetId,
    minutes: grant.minutes,
    ...(grant.reason !== undefined ? { reason: grant.reason } : {}),
    test: grant.test,
    state: grant.state,
    requestedAt: grant.requestedAt,
    ...(grant.approvedAt !== undefined ? { approvedAt: grant.approvedAt } : {}),
    ...(grant.endsAt !== undefined ? { endsAt: grant.endsAt } : {}),
    ...(grant.approvedBy !== undefined ? { approvedBy: grant.approvedBy } : {}),
    ...(grant.endReason !== undefined ? { endReason: grant.endReason } : {}),
    ...(grant.maintenance ? { maintenance: maintenanceProjection(grant.maintenance) } : {}),
  };
}

/** The key slot of a request: `main` when absent, else `main` or `provisioner`. */
function slotOf(value: unknown): KeySlot {
  if (value === undefined || value === "main") return "main";
  if (value === "provisioner") return "provisioner";
  throw new HttpError(400, "key must be main or provisioner");
}

function text(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value) throw new HttpError(400, `${name} is required`);
  return value;
}

const MIN_PASSPHRASE = 12;

export function sshApi(options: SshApiOptions): Hono {
  const { service, keys, targets, grants, hostAddress } = options;
  const audit =
    options.audit ??
    ((line: string) => {
      console.log(line);
    });
  const hono = new Hono();
  let settingUp = false;

  /** The bytes of each unlock of a request. The `wipeUnlocks` middleware zeroes them when the request ends. */
  const unlocks = new WeakMap<Request, Uint8Array[]>();

  const parseUnlock = (context: Context, value: unknown): UnlockSecret => {
    if (!isObject(value)) throw new HttpError(400, "unlock is required");
    const { method, secret } = value;
    if (method !== "prf" && method !== "passphrase") throw new HttpError(400, "unlock.method is not valid");
    if (typeof secret !== "string" || !B64URL_RE.test(secret) || secret.length > MAX_SECRET_CHARS)
      throw new HttpError(400, "unlock.secret must be base64url text");
    if (method !== keys.method()) throw new HttpError(400, "the unlock method is not the one of this hub");
    const decoded = Buffer.from(secret, "base64url");
    const bytes = new Uint8Array(decoded);
    decoded.fill(0);
    unlocks.get(context.req.raw)?.push(bytes);
    return { method, secret: bytes };
  };

  /** A passphrase that is set (not typed to unlock) needs at least MIN_PASSPHRASE characters (code points). The text is never echoed. */
  const needLongPassphrase = (unlock: UnlockSecret): void => {
    if (unlock.method !== "passphrase") return;
    // The decoder drops a leading byte order mark (U+FEFF), so it is not counted. The web counts the same way.
    let count = 0;
    for (const _point of new TextDecoder().decode(unlock.secret)) count++;
    if (count < MIN_PASSPHRASE) throw new HttpError(400, `the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  };

  const wipeUnlocks: MiddlewareHandler = async (context, next) => {
    const list: Uint8Array[] = [];
    unlocks.set(context.req.raw, list);

    try {
      await next();
    } finally {
      for (const bytes of list) bytes.fill(0);
      unlocks.delete(context.req.raw);
    }
  };

  const needTarget = (context: Context): Target => {
    const target = targets.get(context.req.param("id") ?? "");
    if (!target) throw new TargetError(404, "no such target");
    return target;
  };

  // The per-target locks of the routes that change a target. `editing` is held by PATCH, by the key routes, by the
  // provisioner key routes and by the approve of a `sources` or `install` grant, `retiring` by DELETE and by the approve
  // of an `uninstall` grant. A route that takes the lock adds the id before its first await. These locks last for one
  // request. While a maintenance grant of the target is pending, active or still running, `maintenanceFor` is the lock:
  // it clears by itself on a deny, an expiry, the end of the run and a restart of the hub.
  const editing = new Set<string>();
  const retiring = new Set<string>();

  /** 409 when a retire, another change or a maintenance grant of the target runs. */
  const needIdle = (id: string): void => {
    if (retiring.has(id)) throw new TargetError(409, "this target is being retired");
    if (editing.has(id)) throw new TargetError(409, "this target is being changed");
    if (service.maintenanceFor(id)) throw new TargetError(409, MAINTENANCE_BUSY);
  };

  /** Runs `work` under the lock of a target: 409 when a retire or another change runs, and the lock is always freed. */
  const locked = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    needIdle(id);
    editing.add(id);

    try {
      return await work();
    } finally {
      editing.delete(id);
    }
  };

  /** Only an external target of a POSIX type has a provisioner key. */
  const needProvisionerTarget = (target: Target): void => {
    if (target.managedHost !== undefined) throw new HttpError(400, "a managed target has no provisioner key");
    if (target.systemType === "windows") throw new HttpError(400, "a windows target has no provisioner key");
  };

  /**
   * A passphrase is shared by all keys, so a typo would seal a key under a passphrase that no one knows: check it
   * against a key that is open (any target, any slot). Without one, only the length is checked. A passkey makes
   * another secret for each salt, so there is nothing to check against.
   */
  const checkUnlock = async (unlock: UnlockSecret): Promise<void> => {
    if (unlock.method !== "passphrase") return;
    const other = targets
      .list()
      .flatMap((item) => (["main", "provisioner"] as const).map((slot) => ({ id: item.id, slot })))
      .find((item) => hasOpenKey(item.id, item.slot));

    if (other) (await keys.open(other.id, unlock, other.slot)).destroy();
    else needLongPassphrase(unlock);
  };

  /** A key that a passphrase can be checked against: it exists and a recovery has not made it wait for a re-wrap. */
  const hasOpenKey = (targetId: string, slot: KeySlot = "main"): boolean =>
    hasKey(targetId, slot) && !keys.pendingRewraps(slot).includes(targetId);

  const hasKey = (targetId: string, slot: KeySlot = "main"): boolean => {
    try {
      keys.publicLine(targetId, slot);
      return true;
    } catch {
      return false;
    }
  };

  const sourcesOf = (target: Pick<Target, "nodes">): string[] => targets.sourcesOf(target);

  /** An external target whose changes go through a maintenance grant: its provisioner fields and key are there. */
  const withProvisioner = (target: Target): boolean =>
    target.managedHost === undefined && hasProvisioner(target) && hasKey(target.id, "provisioner");

  /** The source address of the node `local`, or a 409. The hub reaches a target through it. */
  const needLocalSource = (): string => {
    const local = targets.nodeAccess(LOCAL_HOST);
    if (local?.enabled !== true || !local.sourceAddress)
      throw new TargetError(409, "turn on SSH access for the node local with a source address");
    return local.sourceAddress;
  };

  /** The detail of a maintenance run, for a text. */
  const detailOf = (grant: Grant): string => {
    const detail = grant.maintenance?.detail ?? "";
    return detail === "" ? "the run failed" : detail;
  };

  const installLine = (target: Target): string => {
    const sources = sourcesOf(target);
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");
    return authorizedKeysLine(keys.publicLine(target.id), sources);
  };

  /** Tells the nodes their targets. A node that cannot be reached is noted: the change itself stands. */
  const push = async (hostIds: string[]): Promise<boolean> => {
    let all = true;

    for (const hostId of new Set(hostIds)) {
      try {
        await service.pushTargets(hostId);
      } catch (error) {
        all = false;
        audit(`audit ssh node=${logToken(hostId)} push failed=${logToken(message(error))}`);
      }
    }

    return all;
  };

  /**
   * A disable or a retire ends the active grants and refuses the pending ones: the node tells the waiting session.
   * With `hostIds`, only the grants of those nodes end (a node that left the list of the target).
   */
  // A maintenance grant is never ended here: the disable of a retire and the change of nodes run while the grant that
  // does the work is pending or active, and `local` can be a session node of the target that leaves the list.
  const endGrantsOf = (targetId: string, hostIds?: string[]) =>
    grants.endWhere(
      (grant) =>
        grant.maintenance === undefined &&
        grant.targetId === targetId &&
        (hostIds === undefined || hostIds.includes(grant.nodeId)),
      "target-disabled",
    );

  interface Removal {
    line: "removed" | "not-found" | "failed" | "manual";
    detail?: string;
  }

  /**
   * The last steps of a retire: both keys and the record go, the grants end, and the nodes are told. The answer names
   * the lines that stay on the machine when the hub did not remove them, and the script of a provisioner.
   */
  const retire = async (target: Target, removal: Removal) => {
    await keys.remove(target.id);
    await targets.remove(target.id);
    endGrantsOf(target.id);
    await push(target.nodes);
    audit(`audit ssh target=${logToken(target.id)} retired line=${removal.line}`);
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
  };

  /** The list of nodes of a PATCH: the rules of a new target, and each host must exist. */
  const parseNodes = (value: unknown): string[] => {
    if (!Array.isArray(value) || !value.every((node) => typeof node === "string"))
      throw new HttpError(400, "nodes must be a list of host ids");
    if (value.length > MAX_NODES) throw new HttpError(400, `nodes can hold at most ${MAX_NODES} host ids`);
    if (!value.every((node: string) => HOST_ID_RE.test(node))) throw new HttpError(400, "a node id is not valid");
    if (new Set(value).size !== value.length) throw new HttpError(400, "nodes has a duplicate");
    const known = options.hostIds();
    const unknown = value.find((node: string) => !known.includes(node));
    if (unknown !== undefined) throw new HttpError(400, `no such host: ${unknown}`);
    return [...value];
  };

  hono.onError((error, context) => {
    let status = 500;
    let body = "internal error";

    if (error instanceof HttpError || error instanceof GrantError || error instanceof TargetError) {
      status = error.status;
      body = error.message;
    } else if (error instanceof KeyError) {
      status =
        error.code === "wrong-unlock" || error.code === "wrong-recovery-code"
          ? 403
          : error.code === "bad-recovery-key"
            ? 400
            : 409;
      body = error.code === "wrong-recovery-code" ? "wrong recovery code" : error.message;
    } else if (error instanceof NodeError) {
      status = 502;
      body = error.message;
    } else console.error(error);

    return context.json({ error: body }, status as 400);
  });

  const auditWrites: MiddlewareHandler = async (context, next) => {
    await next();
    if (context.req.method === "GET" || context.req.method === "HEAD" || context.req.method === "OPTIONS") return;
    const user = context.get("user" as never) as User | undefined;
    audit(
      `audit user=${logToken(options.user(context))} role=${user?.role ?? "read"} ssh ${context.req.method} ${new URL(context.req.url).pathname} ${context.res.status}`,
    );
  };

  const needSetUp: MiddlewareHandler = async (_context, next) => {
    if (!keys.isSetUp()) throw new HttpError(409, "SSH access is not set up");
    await next();
  };

  hono.use("*", auditWrites);
  hono.use("*", wipeUnlocks);
  for (const path of ["/recovery/*", "/nodes/*", "/targets", "/targets/*", "/grants", "/grants/*"])
    hono.use(path, needSetUp);

  hono.get("/status", (context) => {
    const nodes = options.hostIds().map((host) => {
      const access = targets.nodeAccess(host);
      return { host, enabled: access?.enabled ?? false, sourceAddress: access?.sourceAddress ?? "" };
    });
    const method = keys.method();
    const credentialId = keys.credentialId();
    return context.json({
      setUp: keys.isSetUp(),
      ...(method ? { method } : {}),
      ...(credentialId ? { credentialId } : {}),
      pendingRewrap: keys.pendingRewraps(),
      pendingProvisionerRewrap: keys.pendingRewraps("provisioner"),
      hasKeys: targets.list().some((item) => hasOpenKey(item.id)),
      nodes,
    });
  });

  hono.post("/setup", async (context) => {
    const body = await readObject(context);
    const { method, credentialId } = body;
    if (method !== "prf" && method !== "passphrase") throw new HttpError(400, "method must be prf or passphrase");

    if (method === "prf") {
      if (typeof credentialId !== "string" || !B64URL_RE.test(credentialId) || credentialId.length > MAX_SECRET_CHARS)
        throw new HttpError(400, "credentialId must be base64url text");
    } else if (credentialId !== undefined) throw new HttpError(400, "credentialId is for a passkey only");

    if (keys.isSetUp() || settingUp) throw new HttpError(409, "SSH access is set up already");
    settingUp = true;

    try {
      const recovery = newRecovery();
      await keys.setup({
        method,
        ...(typeof credentialId === "string" ? { credentialId } : {}),
        recoveryPublicKey: recovery.publicKey,
      });
      context.header("cache-control", "no-store");
      return context.json({ recoveryCode: recovery.code });
    } finally {
      settingUp = false;
    }
  });

  hono.post("/recovery/begin", async (context) => {
    const body = await readObject(context);
    const { method, credentialId } = body;
    const code = text(body, "code");
    if (code.length > MAX_SECRET_CHARS) throw new HttpError(400, "code is too long");
    if (method !== "prf" && method !== "passphrase") throw new HttpError(400, "method must be prf or passphrase");

    if (method === "prf") {
      if (typeof credentialId !== "string" || !B64URL_RE.test(credentialId) || credentialId.length > MAX_SECRET_CHARS)
        throw new HttpError(400, "credentialId must be base64url text");
    } else if (credentialId !== undefined) throw new HttpError(400, "credentialId is for a passkey only");

    const { targets: pending } = await keys.beginRecovery({
      code,
      method,
      ...(typeof credentialId === "string" ? { credentialId } : {}),
    });
    // A recovery follows a lost or stolen unlock: a grant that it approved must not outlive it.
    grants.endWhere((grant) => grant.state === "active", "revoked");
    audit(
      `audit ssh recovery user=${logToken(options.user(context))} method=${method} targets=${pending.length} provisioner=${keys.pendingRewraps("provisioner").length}`,
    );
    return context.json({ targets: pending });
  });

  hono.put("/nodes/:host", async (context) => {
    const host = context.req.param("host");
    const body = await readObject(context);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    if (typeof body.sourceAddress !== "string") throw new HttpError(400, "sourceAddress is required");
    if (!options.hostIds().includes(host)) throw new HttpError(404, "no such host");
    await targets.setNodeAccess(host, { enabled: body.enabled, sourceAddress: body.sourceAddress });
    const pushed = await push([host]);
    // The provisioner line of each target allows the source of `local` at its install only. After a change, the
    // maintenance of those targets is refused until the owner installs the provisioner again.
    const stale =
      host === LOCAL_HOST
        ? targets
            .list()
            .filter((item) => hasProvisioner(item) && (!body.enabled || item.provisionerSource !== body.sourceAddress))
            .map((item) => item.id)
        : undefined;
    return context.json({
      host,
      enabled: body.enabled,
      sourceAddress: body.sourceAddress,
      pushed,
      ...(stale ? { staleProvisioners: stale } : {}),
    });
  });

  hono.get("/targets", (context) => context.json(targets.list()));

  hono.post("/targets", async (context) => {
    const body = await readObject(context);
    const id = text(body, "id");
    const account = text(body, "account");
    if (!isSystemType(body.systemType)) throw new HttpError(400, "systemType is not valid");
    if (!Array.isArray(body.nodes) || !body.nodes.every((node) => typeof node === "string"))
      throw new HttpError(400, "nodes must be a list of host ids");
    if (body.managedHost !== undefined && typeof body.managedHost !== "string")
      throw new HttpError(400, "managedHost must be a host id");
    if (body.keyFile !== undefined && typeof body.keyFile !== "string")
      throw new HttpError(400, "keyFile must be text");
    const keyFileBad = keyFileProblem(body.keyFile, body.systemType, body.managedHost !== undefined);
    if (keyFileBad) throw new HttpError(400, keyFileBad);
    if (body.address !== undefined && typeof body.address !== "string")
      throw new HttpError(400, "address must be text");
    if (body.port !== undefined && typeof body.port !== "number") throw new HttpError(400, "port must be a number");
    let address = body.address;

    if (address === undefined && body.managedHost === LOCAL_HOST) {
      // The hub cannot tell how the other nodes see its own host, and the public URL names another machine.
      const known = targets.nodeAccess(LOCAL_HOST)?.sourceAddress;
      if (!known) throw new HttpError(400, "give the address of this host: the hub cannot tell it");
      address = known;
    } else if (address === undefined && body.managedHost !== undefined) address = hostAddress(body.managedHost);

    if (address === undefined) throw new HttpError(400, "address is required");

    const target = await targets.add({
      id,
      address,
      port: body.port ?? DEFAULT_PORT,
      account,
      systemType: body.systemType,
      nodes: body.nodes,
      ...(body.managedHost !== undefined ? { managedHost: body.managedHost } : {}),
      ...(body.keyFile !== undefined ? { keyFile: body.keyFile } : {}),
    });
    await push(target.nodes);
    return context.json(target, 201);
  });

  hono.get("/targets/:id", (context) => {
    const target = needTarget(context);
    return context.json({ ...target, notes: installNotes(target.systemType) });
  });

  // A change of the nodes of one target runs one at a time. A retire of the same target waits out with 409.

  // The body holds `state`, `nodes` or both. A new list of nodes changes the `from=` part of the key line of the target:
  // a managed target gets the new line before the list is stored, and a failed install leaves the list as it was (502),
  // because a list that the machine does not match would let the hub approve a node that the machine refuses. An external target
  // gets the new line in the answer (`installLine`), and `GET /targets/:id/provision` gives it later. The grants of a
  // node that left the list end. The nodes of the old and the new list get the target list.
  // An external target with a key and a provisioner stores nothing here: a new list answers `202 { maintenance }`, and
  // the approve of that grant runs `sources` on the target, then stores the list. When the new list allows none of
  // the addresses of the old list, the body needs `confirm: true` (else 409). `state` and `nodes` go in two calls then.
  hono.patch("/targets/:id", async (context) => {
    needTarget(context);
    const body = await readObject(context);
    const hasState = body.state !== undefined;
    const hasNodes = body.nodes !== undefined;
    if (!hasState && !hasNodes) throw new HttpError(400, "give state, nodes or both");
    if (hasState && body.state !== "disabled" && body.state !== "draft")
      throw new HttpError(400, "state must be disabled or draft");
    const nodes = hasNodes ? parseNodes(body.nodes) : undefined;
    const state = hasState ? (body.state as TargetState) : undefined;
    if (body.confirm !== undefined && typeof body.confirm !== "boolean")
      throw new HttpError(400, "confirm must be true or false");
    const id = context.req.param("id") ?? "";
    needIdle(id);
    editing.add(id);

    let newLine: string | undefined;
    let lineUpdated = false;
    let pushHosts: string[] = [];

    try {
      // Read again under the lock: the target can have changed while the body was read.
      const target = needTarget(context);
      pushHosts = target.nodes;

      if (nodes !== undefined && hasKey(target.id) && withProvisioner(target)) {
        if (hasState)
          throw new HttpError(400, "for a target with a provisioner, send the state and the nodes in two calls");
        const fromSources = sourcesOf(target);
        const toSources = sourcesOf({ nodes });
        if (toSources.length === 0)
          throw new TargetError(409, "no node of the new list has access enabled with a source address");
        // With no address that works now, there is nothing to lock out, so no confirm is needed.
        if (
          fromSources.length > 0 &&
          !toSources.some((source) => fromSources.includes(source)) &&
          body.confirm !== true
        )
          throw new TargetError(
            409,
            "the new list allows none of the addresses that work now: send it again with confirm",
          );
        const grant = service.requestMaintenance({
          targetId: target.id,
          action: "sources",
          toNodes: nodes,
          by: options.user(context),
        });
        return context.json({ maintenance: projection(grant) }, 202);
      }

      if (nodes !== undefined) {
        const next = { ...target, nodes };
        const withKey = hasKey(target.id);
        // A target with a key keeps a valid line only while one node has access and a source address.
        if (withKey && sourcesOf(next).length === 0)
          throw new TargetError(409, "no node of the new list has access enabled with a source address");

        if (withKey && target.managedHost !== undefined) {
          // The line goes to the machine before the list is stored, so a failed install leaves the store as it was and
          // no node of the new list is trusted meanwhile. The script writes nothing when the exact line is there.
          try {
            await service.authorizeManaged(target.id, nodes);
            lineUpdated = true;
          } catch (error) {
            // The machine may have taken the new line before the failure: try to put the old line back.
            await service.authorizeManaged(target.id).catch((again: unknown) => {
              audit(`audit ssh target=${logToken(target.id)} line restore failed=${logToken(message(again))}`);
            });
            audit(`audit ssh target=${logToken(target.id)} nodes change failed=${logToken(message(error))}`);
            throw new NodeError(
              `the key line on the machine was not updated, so the node list is as it was: ${message(error)}`,
            );
          }

          try {
            await targets.setNodes(target.id, nodes);
          } catch (error) {
            // The machine has the new line, the store the old list: put the old line back and keep this error.
            await service.authorizeManaged(target.id).catch((again: unknown) => {
              audit(`audit ssh target=${logToken(target.id)} line restore failed=${logToken(message(again))}`);
            });
            throw error;
          }
        } else {
          await targets.setNodes(target.id, nodes);
          if (withKey) newLine = installLine(next);
        }

        const removed = target.nodes.filter((node) => !nodes.includes(node));
        if (removed.length > 0) endGrantsOf(target.id, removed);
        pushHosts = [...target.nodes, ...nodes];
      }

      if (state !== undefined) {
        if (state === "disabled") endGrantsOf(target.id);
        await targets.setState(target.id, state);
      }
    } finally {
      editing.delete(id);
    }

    const pushed = await push(pushHosts);
    return context.json({
      ...targets.get(id),
      ...(nodes !== undefined ? { pushed } : {}),
      ...(newLine !== undefined ? { installLine: newLine } : {}),
      ...(lineUpdated ? { lineUpdated } : {}),
    });
  });

  // A retire deletes the target: the grants end, a managed node removes the key line, then the key and the record go.
  // The removal can take a few seconds. The target is disabled first, so that no request and no approval gets a key
  // meanwhile, and the grants end again after the delete. A second retire of the same id gets 409 while the first runs.
  // An external target with a provisioner is not deleted here: the answer is `202 { maintenance }` for the action
  // `uninstall`, and the approve of that grant removes both key lines from the machine and then retires. The checks of
  // the grant come first, so a refusal changes nothing. Then the target is disabled and the session grants end, as
  // today. A deny or an expiry of the grant leaves the target `disabled` with both keys. `?cleanup=none` skips the run
  // and retires at once (`line: "manual"`). It changes nothing for another target.

  hono.delete("/targets/:id", async (context) => {
    const cleanup = context.req.query("cleanup");
    if (cleanup !== undefined && cleanup !== "none") throw new HttpError(400, "cleanup must be none");
    const target = needTarget(context);
    needIdle(target.id);
    retiring.add(target.id);

    try {
      if (cleanup === undefined && withProvisioner(target)) {
        const grant = service.requestMaintenance({
          targetId: target.id,
          action: "uninstall",
          by: options.user(context),
        });

        try {
          await targets.setState(target.id, "disabled");
        } catch (error) {
          if (grants.get(grant.id)?.state === "pending") grants.deny(grant.id, "system");
          throw error;
        }

        endGrantsOf(target.id);
        await push(target.nodes);
        return context.json({ maintenance: projection(grants.get(grant.id) ?? grant) }, 202);
      }

      await targets.setState(target.id, "disabled");
      endGrantsOf(target.id);
      // The key line is read before the key is deleted. A failed removal never stops the retire.
      const removal: Removal =
        target.managedHost === undefined ? { line: "manual" } : await service.deauthorizeManaged(target.id);
      return context.json(await retire(target, removal));
    } finally {
      retiring.delete(target.id);
    }
  });

  hono.get("/targets/:id/salt", async (context) => {
    const target = needTarget(context);
    const slot = slotOf(context.req.query("key"));
    if (slot === "provisioner") needProvisionerTarget(target);
    // A salt that is made while a retire runs could stay behind after the retire.
    if (retiring.has(target.id)) throw new TargetError(409, "this target is being retired");
    const method = keys.method();
    const credentialId = keys.credentialId();
    return context.json({
      salt: await keys.saltFor(target.id, slot),
      method,
      ...(credentialId ? { credentialId } : {}),
    });
  });

  hono.post("/targets/:id/rewrap", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const code = text(body, "code");
    if (code.length > MAX_SECRET_CHARS) throw new HttpError(400, "code is too long");
    const unlock = parseUnlock(context, body.unlock);
    const slot = slotOf(body.key);
    if (!keys.pendingRewraps(slot).includes(target.id))
      throw new TargetError(409, "this target does not need a re-wrap");
    // A typed passphrase is checked against a key that is open already, so a typo cannot seal this key under it.
    // The re-wrap itself is safe against a retire: it fails when the key is gone, and writes nothing then.
    await checkUnlock(unlock);
    await keys.rewrapWithRecovery(target.id, code, unlock, slot);
    audit(
      `audit ssh rewrap user=${logToken(options.user(context))} target=${logToken(target.id)}${slot === "main" ? "" : ` key=${slot}`}`,
    );
    return context.body(null, 204);
  });

  hono.post("/targets/:id/key", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    // The lock keeps a retire from deleting the target between the checks and the write of the key.
    return locked(target.id, async () => {
      if (hasKey(target.id)) throw new TargetError(409, "the target has a key already");
      const sources = sourcesOf(target);
      if (sources.length === 0)
        throw new TargetError(409, "no node of this target has access enabled with a source address");

      await checkUnlock(unlock);
      const made = await keys.create(target.id, unlock);
      await targets.setKeyFingerprint(target.id, made.fingerprint);
      return context.json({
        publicLine: made.publicLine,
        fingerprint: made.fingerprint,
        installLine: authorizedKeysLine(made.publicLine, sources),
        notes: installNotes(target.systemType),
      });
    });
  });

  // The provisioner key: a second key that the hub holds for an external target. It is made like the main key, with
  // its own salt. A managed target and a windows target have none (a managed node maintains its own key file, and the
  // script is a POSIX sh script). A second POST gives 409. To repair or replace the key: DELETE the key here, POST a new
  // one, and install it on the target with the owner's own `--identity` key (the bootstrap path). The DELETE does not
  // touch the main key, and the owner is not locked out, because the script on the target still takes the old line
  // until the owner replaces it by hand. Both routes hold the lock of the target, so a retire or a PATCH waits (409).
  hono.post("/targets/:id/provisioner-key", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    needProvisionerTarget(target);

    return locked(target.id, async () => {
      if (hasKey(target.id, "provisioner")) throw new TargetError(409, "the target has a provisioner key already");
      await checkUnlock(unlock);
      const made = await keys.create(target.id, unlock, "provisioner");
      return context.json({ publicLine: made.publicLine, fingerprint: made.fingerprint });
    });
  });

  hono.delete("/targets/:id/provisioner-key", (context) => {
    const target = needTarget(context);

    return locked(target.id, async () => {
      if (!hasKey(target.id, "provisioner") && !hasProvisioner(target))
        throw new TargetError(404, "the target has no provisioner key");
      await keys.removeSlot(target.id, "provisioner");
      await targets.setProvisioner(target.id, undefined);
      audit(`audit ssh target=${logToken(target.id)} provisioner key removed user=${logToken(options.user(context))}`);
      return context.body(null, 204);
    });
  });

  // The install of a provisioner, after the key: the owner runs this script on the target with the own key of the owner
  // (`--identity`), next to the install of the main line. It writes the script and its state file and adds the
  // provisioner line, which allows the source of `local` only. Then `provisioner-installed` stores the path that the
  // script printed, and `reinstall` ends the add with one maintenance `install` (one more unlock).
  hono.get("/targets/:id/provisioner-install", (context) => {
    const target = needTarget(context);
    needProvisionerTarget(target);
    if (target.systemType === "dropbear")
      throw new TargetError(409, "the provisioner script for a dropbear target is not available yet");
    if (!hasKey(target.id)) throw new TargetError(409, "the target has no key: make the main key first");
    if (!hasKey(target.id, "provisioner")) throw new TargetError(409, "the target has no provisioner key");
    const localSource = needLocalSource();
    const sources = sourcesOf(target);
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");

    try {
      return context.json(
        linuxInstallScript({
          targetId: target.id,
          mainPublicLine: keys.publicLine(target.id),
          provisionerPublicLine: keys.publicLine(target.id, "provisioner"),
          localSource,
          sources,
        }),
      );
    } catch (error) {
      // A source with a pattern, for example: the script takes exact addresses and host names only.
      throw new TargetError(409, `the install script cannot be made: ${message(error)}`);
    }
  });

  // The fingerprint comes from the stored key and the source from the access of `local` now, never from the body.
  hono.post("/targets/:id/provisioner-installed", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    needProvisionerTarget(target);
    const script = body.script;
    if (typeof script !== "string" || !SCRIPT_PATH_RE.test(script) || !script.endsWith(`/provisioner-${target.id}.sh`))
      throw new HttpError(400, "script must be the absolute path of the provisioner script of this target");

    return locked(target.id, async () => {
      if (!hasKey(target.id, "provisioner")) throw new TargetError(409, "the target has no provisioner key");
      const source = needLocalSource();
      const blob = keys.publicLine(target.id, "provisioner").split(" ")[1] ?? "";
      const fingerprint = keyFingerprint(new Uint8Array(Buffer.from(blob, "base64")));
      await targets.setProvisioner(target.id, { fingerprint, script, source });
      audit(`audit ssh target=${logToken(target.id)} provisioner installed user=${logToken(options.user(context))}`);
      return context.json(targets.get(target.id));
    });
  });

  // Puts the main line back on the target with the stored list (`sources`, `on`, `status`): the end of an add, and a
  // repair. It answers `202 { maintenance }`, and the approve runs it.
  hono.post("/targets/:id/reinstall", (context) => {
    const target = needTarget(context);
    needIdle(target.id);
    const grant = service.requestMaintenance({ targetId: target.id, action: "install", by: options.user(context) });
    return context.json({ maintenance: projection(grant) }, 202);
  });

  hono.post("/targets/:id/scan", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    return context.json({ keys: await service.scanHostKey(target.id, text(body, "node")) });
  });

  hono.post("/targets/:id/pin", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const hostKey = text(body, "hostKey");
    if (!HOST_KEY_RE.test(hostKey)) throw new HttpError(400, "hostKey must be `<type> <base64>`");
    await targets.setHostKey(target.id, hostKey);
    return context.json(targets.get(target.id));
  });

  hono.post("/targets/:id/pin-managed", async (context) => {
    const target = needTarget(context);
    return context.json({ keys: await service.pinManaged(target.id) });
  });

  hono.get("/targets/:id/provision", (context) => {
    const target = needTarget(context);
    return context.json(provisionScript(target.systemType, installLine(target), { account: target.account }));
  });

  hono.post("/targets/:id/authorize", async (context) => {
    const target = needTarget(context);
    await service.authorizeManaged(target.id);
    return context.json({ ok: true });
  });

  hono.post("/targets/:id/test", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const node = text(body, "node");
    const unlock = parseUnlock(context, body.unlock);
    return context.json(await service.test(target.id, node, options.user(context), unlock));
  });

  hono.get("/grants", (context) => context.json(grants.list().map(projection)));

  /** Holds a lock of one request for the approve of a maintenance grant. Nobody else takes it while the grant waits. */
  const hold = (set: Set<string>, id: string): void => {
    if (retiring.has(id) || editing.has(id)) throw new TargetError(409, "this target is being changed");
    set.add(id);
  };

  /** The approve of a `sources` grant: the run, then the new list in the store, while the grant is still active. */
  const approveSources = async (context: Context, grantId: string, work: Maintenance, unlock: UnlockSecret) => {
    const targetId = grants.get(grantId)?.targetId ?? "";

    const commit: MaintenanceCommit = async (grant, signal) => {
      const plan = grant.maintenance;
      const toNodes = plan?.toNodes;
      if (!plan || !toNodes) throw new Error("the grant has no node list");
      await targets.setNodes(targetId, toNodes);

      if (signal.aborted) {
        // The time limit passed during the write, and the old list went back on the target: so it goes back here too.
        await targets.setNodes(targetId, plan.fromNodes).then(
          () => {
            audit(`audit ssh target=${logToken(targetId)} late commit undone`);
          },
          (error: unknown) => {
            audit(`audit ssh target=${logToken(targetId)} late commit undo failed=${logToken(message(error))}`);
          },
        );
        return;
      }

      // The grants of the nodes that left the list end (a maintenance grant never does).
      const removed = plan.fromNodes.filter((node) => !toNodes.includes(node));
      if (removed.length > 0) endGrantsOf(targetId, removed);
    };

    const grant = await service.approve(grantId, options.user(context), unlock, undefined, { commit });
    if (grant.maintenance?.result !== "done")
      throw new NodeError(
        `the key line on the machine was not updated, so the node list is as it was: ${detailOf(grant)}`,
      );
    const pushed = await push([...work.fromNodes, ...(work.toNodes ?? [])]);
    return context.json({ ...projection(grant), target: targets.get(targetId), pushed, lineUpdated: true });
  };

  /**
   * The approve of an `uninstall` grant. Once the owner approved it, the retire goes on whatever the run gave: a line
   * without its private key is harmless, and the answer names the lines to remove by hand. A refusal before the
   * approve (a wrong unlock, a change that is out of date) stops the retire, and the target stays `disabled`.
   */
  const approveUninstall = async (context: Context, grantId: string, unlock: UnlockSecret) => {
    const target = targets.get(grants.get(grantId)?.targetId ?? "");
    let failure: { error: unknown } | undefined;

    try {
      await service.approve(grantId, options.user(context), unlock);
    } catch (error) {
      failure = { error };
    }

    const grant = grants.get(grantId);
    if (!target || grant?.approvedAt === undefined)
      throw failure ? failure.error : new GrantError(404, "no such grant");
    const removed = !failure && grant.maintenance?.result === "done";
    const why = failure ? message(failure.error) : detailOf(grant);
    const removal: Removal = removed
      ? { line: "removed" }
      : {
          line: "failed",
          detail: `${why}. The key lines stay on the machine: remove the lines that end with claude-rc:${target.id} and claude-rc-provisioner:${target.id}`,
        };
    return context.json({ ...projection(grant), retired: await retire(target, removal) });
  };

  // For a maintenance grant, the approve runs the action and commits the change: read the comment at the top.
  hono.post("/grants/:id/approve", async (context) => {
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    if (body.minutes !== undefined && typeof body.minutes !== "number")
      throw new HttpError(400, "minutes must be a number");
    const grantId = context.req.param("id");
    const waiting = grants.get(grantId);
    const work = waiting?.state === "pending" ? waiting.maintenance : undefined;

    if (!waiting || !work) {
      const grant = await service.approve(grantId, options.user(context), unlock, body.minutes);
      return context.json(projection(grant));
    }

    const lock = work.action === "uninstall" ? retiring : editing;
    hold(lock, waiting.targetId);

    try {
      if (work.action === "sources") return await approveSources(context, grantId, work, unlock);
      if (work.action === "uninstall") return await approveUninstall(context, grantId, unlock);
      const grant = await service.approve(grantId, options.user(context), unlock);
      if (grant.maintenance?.result !== "done")
        throw new NodeError(`the key line was not put back on the machine: ${detailOf(grant)}`);
      return context.json(projection(grant));
    } finally {
      lock.delete(waiting.targetId);
    }
  });

  hono.post("/grants/:id/deny", (context) =>
    context.json(projection(grants.deny(context.req.param("id"), options.user(context)))),
  );

  hono.post("/grants/:id/revoke", async (context) =>
    context.json(projection(await service.revoke(context.req.param("id"), options.user(context)))),
  );

  return hono;
}
