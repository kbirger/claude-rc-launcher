import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HOST_ID_RE } from "./hostid";
import { HttpError } from "./instances";
import { isObject, readObject } from "./requests";
import { logToken } from "./roles";
import { GrantError } from "./sshgrants";
import type { Grant, GrantStore, Maintenance } from "./sshgrants";
import { KeyError } from "./sshkeystore";
import type { KeySlot, SshKeyStore, UnlockSecret } from "./sshkeystore";
import { NodeError } from "./sshservice";
import type { SshService } from "./sshservice";
import { TargetLocks } from "./sshtargetlocks";
import { HOST_KEY_RE, installNotes, isSystemType, keyFileProblem, MAX_NODES, TargetError } from "./sshtargets";
import type { TargetState, TargetStore } from "./sshtargets";
import { SshTargetService } from "./sshtargetservice";
import type { ApproveResult } from "./sshtargetservice";
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
    ...(work.started !== undefined ? { started: work.started } : {}),
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

/** The answer of an approve. */
function approveAnswer(result: ApproveResult) {
  if (result.kind === "sources")
    return { ...projection(result.grant), target: result.target, pushed: result.pushed, lineUpdated: true };
  if (result.kind === "uninstall") return { ...projection(result.grant), retired: result.retired };
  return projection(result.grant);
}

/**
 * The routes parse and check a request, call one method of `SshTargetService` (or of `SshService` and the stores for
 * a plain read or write) and map its result. The rules and the locks of targets live in `SshTargetService` and
 * `TargetLocks`.
 */
export function sshApi(options: SshApiOptions): Hono {
  const { service, keys, targets, grants } = options;
  const audit =
    options.audit ??
    ((line: string) => {
      console.log(line);
    });
  const locks = new TargetLocks(service);
  const domain = new SshTargetService({
    service,
    keys,
    targets,
    grants,
    locks,
    hostAddress: options.hostAddress,
    hostIds: options.hostIds,
    audit,
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

  const needTarget = (context: Context) => domain.need(context.req.param("id") ?? "");

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

  /** The `method` and `credentialId` of a setup or a recovery. */
  const parseMethod = (body: Record<string, unknown>): { method: "prf" | "passphrase"; credentialId?: string } => {
    const { method, credentialId } = body;
    if (method !== "prf" && method !== "passphrase") throw new HttpError(400, "method must be prf or passphrase");

    if (method === "prf") {
      if (typeof credentialId !== "string" || !B64URL_RE.test(credentialId) || credentialId.length > MAX_SECRET_CHARS)
        throw new HttpError(400, "credentialId must be base64url text");
    } else if (credentialId !== undefined) throw new HttpError(400, "credentialId is for a passkey only");

    return { method, ...(typeof credentialId === "string" ? { credentialId } : {}) };
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

  hono.get("/status", (context) => context.json(domain.status()));

  hono.post("/setup", async (context) => {
    const body = await readObject(context);
    const method = parseMethod(body);
    if (keys.isSetUp() || settingUp) throw new HttpError(409, "SSH access is set up already");
    settingUp = true;

    try {
      const recovery = newRecovery();
      await keys.setup({ ...method, recoveryPublicKey: recovery.publicKey });
      context.header("cache-control", "no-store");
      return context.json({ recoveryCode: recovery.code });
    } finally {
      settingUp = false;
    }
  });

  hono.post("/recovery/begin", async (context) => {
    const body = await readObject(context);
    const code = text(body, "code");
    if (code.length > MAX_SECRET_CHARS) throw new HttpError(400, "code is too long");
    const method = parseMethod(body);
    return context.json(await domain.beginRecovery({ code, ...method }, options.user(context)));
  });

  hono.put("/nodes/:host", async (context) => {
    const host = context.req.param("host");
    const body = await readObject(context);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    if (typeof body.sourceAddress !== "string") throw new HttpError(400, "sourceAddress is required");
    const result = await domain.setNodeAccess(host, { enabled: body.enabled, sourceAddress: body.sourceAddress });
    return context.json({
      host,
      enabled: body.enabled,
      sourceAddress: body.sourceAddress,
      pushed: result.pushed,
      ...(result.staleProvisioners ? { staleProvisioners: result.staleProvisioners } : {}),
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

    const target = await domain.addTarget({
      id,
      account,
      systemType: body.systemType,
      nodes: body.nodes,
      ...(body.managedHost !== undefined ? { managedHost: body.managedHost } : {}),
      ...(body.keyFile !== undefined ? { keyFile: body.keyFile } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
    });
    return context.json(target, 201);
  });

  hono.get("/targets/:id", (context) => {
    const target = needTarget(context);
    return context.json({ ...target, notes: installNotes(target.systemType) });
  });

  // A change of the nodes of one target runs one at a time. A retire of the same target waits out with 409.
  // The body holds `state`, `nodes` or both, and `confirm`: read `SshTargetService.changeTarget`. A target with a
  // provisioner answers `202 { maintenance }` for a new list. A managed target whose machine does not take the new
  // line answers 502, and the list is as it was. An external target gets the new line in the answer (`installLine`),
  // and `GET /targets/:id/provision` gives it later.
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

    const result = await domain.changeTarget(context.req.param("id"), {
      ...(state !== undefined ? { state } : {}),
      ...(nodes !== undefined ? { nodes } : {}),
      ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
      by: options.user(context),
    });
    if (result.kind === "maintenance") return context.json({ maintenance: projection(result.grant) }, 202);
    return context.json({
      ...result.target,
      ...(result.pushed !== undefined ? { pushed: result.pushed } : {}),
      ...(result.installLine !== undefined ? { installLine: result.installLine } : {}),
      ...(result.lineUpdated ? { lineUpdated: result.lineUpdated } : {}),
    });
  });

  // A retire deletes the target: read `SshTargetService.retire`. A second retire of the same id gets 409 while the
  // first runs. An external target with a provisioner answers `202 { maintenance }` for the action `uninstall`, and the
  // approve of that grant removes both key lines from the machine and then retires. A deny or an expiry of the grant
  // leaves the target `disabled` with both keys. `?cleanup=none` skips the run and retires at once (`line: "manual"`).
  hono.delete("/targets/:id", async (context) => {
    const cleanup = context.req.query("cleanup");
    if (cleanup !== undefined && cleanup !== "none") throw new HttpError(400, "cleanup must be none");
    const result = await domain.retire(context.req.param("id"), {
      manual: cleanup === "none",
      by: options.user(context),
    });
    if (result.kind === "maintenance") return context.json({ maintenance: projection(result.grant) }, 202);
    return context.json(result.report);
  });

  hono.get("/targets/:id/salt", async (context) => {
    const target = needTarget(context);
    const slot = slotOf(context.req.query("key"));
    return context.json(await domain.salt(target, slot));
  });

  hono.post("/targets/:id/rewrap", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const code = text(body, "code");
    if (code.length > MAX_SECRET_CHARS) throw new HttpError(400, "code is too long");
    const unlock = parseUnlock(context, body.unlock);
    const slot = slotOf(body.key);
    await domain.rewrap(target, code, unlock, slot, options.user(context));
    return context.body(null, 204);
  });

  hono.post("/targets/:id/key", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    return context.json(await domain.createKey(target.id, unlock));
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
    return context.json(await domain.createProvisionerKey(target, unlock));
  });

  hono.delete("/targets/:id/provisioner-key", async (context) => {
    const target = needTarget(context);
    await domain.removeProvisionerKey(target, options.user(context));
    return context.body(null, 204);
  });

  // The install of a provisioner, after the key: the owner runs this script on the target with the own key of the owner
  // (`--identity`), next to the install of the main line. It writes the script and its state file and adds the
  // provisioner line, which allows the source of `local` only. Then `provisioner-installed` stores the path that the
  // script printed, and `reinstall` ends the add with one maintenance `install` (one more unlock).
  hono.get("/targets/:id/provisioner-install", (context) =>
    context.json(domain.provisionerInstallScript(needTarget(context))),
  );

  // The fingerprint comes from the stored key and the source from the access of `local` now, never from the body.
  hono.post("/targets/:id/provisioner-installed", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    return context.json(await domain.recordProvisionerInstall(target, body.script, options.user(context)));
  });

  // Puts the main line back on the target with the stored list (`sources`, `on`, `status`): the end of an add, and a
  // repair. It answers `202 { maintenance }`, and the approve runs it.
  hono.post("/targets/:id/reinstall", (context) => {
    const grant = domain.reinstall(needTarget(context), options.user(context));
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

  hono.get("/targets/:id/provision", (context) => context.json(domain.provision(needTarget(context))));

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

  // For a maintenance grant, the approve runs the action and commits the change: read the comment at the top.
  hono.post("/grants/:id/approve", async (context) => {
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    if (body.minutes !== undefined && typeof body.minutes !== "number")
      throw new HttpError(400, "minutes must be a number");
    const result = await domain.approve(context.req.param("id"), unlock, body.minutes, options.user(context));
    return context.json(approveAnswer(result));
  });

  hono.post("/grants/:id/deny", (context) =>
    context.json(projection(grants.deny(context.req.param("id"), options.user(context)))),
  );

  hono.post("/grants/:id/revoke", async (context) =>
    context.json(projection(await service.revoke(context.req.param("id"), options.user(context)))),
  );

  return hono;
}
