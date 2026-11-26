import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HOST_ID_RE, LOCAL_HOST } from "./hostid";
import { HttpError } from "./instances";
import { isObject, readObject } from "./requests";
import { logToken } from "./roles";
import { GrantError } from "./sshgrants";
import type { Grant, GrantStore } from "./sshgrants";
import { KeyError } from "./sshkeystore";
import type { SshKeyStore, UnlockSecret } from "./sshkeystore";
import { provisionScript } from "./sshprovision";
import { NodeError } from "./sshservice";
import type { SshService } from "./sshservice";
import {
  authorizedKeysLine,
  HOST_KEY_RE,
  installNotes,
  isSystemType,
  keyFileProblem,
  MAX_NODES,
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
  };
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

  /** A key that a passphrase can be checked against: it exists and a recovery has not made it wait for a re-wrap. */
  const hasOpenKey = (targetId: string): boolean => hasKey(targetId) && !keys.pendingRewraps().includes(targetId);

  const hasKey = (targetId: string): boolean => {
    try {
      keys.publicLine(targetId);
      return true;
    } catch {
      return false;
    }
  };

  const sourcesOf = (target: Target): string[] => targets.sourcesOf(target);

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
  const endGrantsOf = (targetId: string, hostIds?: string[]) =>
    grants.endWhere(
      (grant) => grant.targetId === targetId && (hostIds === undefined || hostIds.includes(grant.nodeId)),
      "target-disabled",
    );

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
    return [...(value as string[])];
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
    audit(`audit ssh recovery user=${logToken(options.user(context))} method=${method} targets=${pending.length}`);
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
    return context.json({ host, enabled: body.enabled, sourceAddress: body.sourceAddress, pushed });
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
  const editing = new Set<string>();
  const retiring = new Set<string>();

  // The body holds `state`, `nodes` or both. A new list of nodes changes the `from=` part of the key line of the target:
  // a managed target gets the new line before the answer, and a failed install puts the old list back (502), because a
  // list that the machine does not match would let the hub approve a node that the machine refuses. An external target
  // gets the new line in the answer (`installLine`), and `GET /targets/:id/provision` gives it later. The grants of a
  // node that left the list end. The nodes of the old and the new list get the target list.
  hono.patch("/targets/:id", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const hasState = body.state !== undefined;
    const hasNodes = body.nodes !== undefined;
    if (!hasState && !hasNodes) throw new HttpError(400, "give state, nodes or both");
    if (hasState && body.state !== "disabled" && body.state !== "draft")
      throw new HttpError(400, "state must be disabled or draft");
    const nodes = hasNodes ? parseNodes(body.nodes) : undefined;
    const state = hasState ? (body.state as TargetState) : undefined;
    if (retiring.has(target.id)) throw new TargetError(409, "this target is being retired");
    if (editing.has(target.id)) throw new TargetError(409, "this target is being changed");

    let newLine: string | undefined;
    let lineUpdated = false;
    let pushHosts = target.nodes;
    editing.add(target.id);

    try {
      if (nodes !== undefined) {
        const next = { ...target, nodes };
        const withKey = hasKey(target.id);
        const sources = sourcesOf(next);
        // A target with a key keeps a valid line only while one node has access and a source address.
        if (withKey && sources.length === 0)
          throw new TargetError(409, "no node of the new list has access enabled with a source address");
        const sourcesChange = sources.join(",") !== sourcesOf(target).join(",");
        await targets.setNodes(target.id, nodes);

        if (withKey && target.managedHost !== undefined && sourcesChange) {
          try {
            await service.authorizeManaged(target.id);
            lineUpdated = true;
          } catch (error) {
            await targets.setNodes(target.id, target.nodes);
            // The machine may have taken the new line before the failure: try to put the old line back.
            await service.authorizeManaged(target.id).catch((again: unknown) => {
              audit(`audit ssh target=${logToken(target.id)} line restore failed=${logToken(message(again))}`);
            });
            audit(`audit ssh target=${logToken(target.id)} nodes change failed=${logToken(message(error))}`);
            throw new NodeError(
              `the key line on the machine was not updated, so the node list is as it was: ${message(error)}`,
            );
          }
        } else if (withKey && target.managedHost === undefined) newLine = installLine(next);

        const removed = target.nodes.filter((node) => !nodes.includes(node));
        if (removed.length > 0) endGrantsOf(target.id, removed);
        pushHosts = [...target.nodes, ...nodes];
      }

      if (state !== undefined) {
        if (state === "disabled") endGrantsOf(target.id);
        await targets.setState(target.id, state);
      }
    } finally {
      editing.delete(target.id);
    }

    const pushed = await push(pushHosts);
    return context.json({
      ...targets.get(target.id),
      ...(nodes !== undefined ? { pushed } : {}),
      ...(newLine !== undefined ? { installLine: newLine } : {}),
      ...(lineUpdated ? { lineUpdated } : {}),
    });
  });

  // A retire deletes the target: the grants end, a managed node removes the key line, then the key and the record go.
  // The removal can take a few seconds. The target is disabled first, so that no request and no approval gets a key
  // meanwhile, and the grants end again after the delete. A second retire of the same id gets 409 while the first runs.

  hono.delete("/targets/:id", async (context) => {
    const target = needTarget(context);
    if (retiring.has(target.id)) throw new TargetError(409, "this target is being retired");
    if (editing.has(target.id)) throw new TargetError(409, "this target is being changed");
    retiring.add(target.id);

    try {
      await targets.setState(target.id, "disabled");
      endGrantsOf(target.id);
      // The key line is read before the key is deleted. A failed removal never stops the retire.
      const removal: { line: "removed" | "not-found" | "failed" | "manual"; detail?: string } =
        target.managedHost === undefined ? { line: "manual" } : await service.deauthorizeManaged(target.id);
      await keys.remove(target.id);
      await targets.remove(target.id);
      endGrantsOf(target.id);
      await push(target.nodes);
      audit(`audit ssh target=${logToken(target.id)} retired line=${removal.line}`);
      return context.json({
        id: target.id,
        account: target.account,
        address: target.address,
        port: target.port,
        systemType: target.systemType,
        managed: target.managedHost !== undefined,
        line: removal.line,
        ...(removal.detail !== undefined ? { detail: removal.detail } : {}),
      });
    } finally {
      retiring.delete(target.id);
    }
  });

  hono.get("/targets/:id/salt", async (context) => {
    const target = needTarget(context);
    const method = keys.method();
    const credentialId = keys.credentialId();
    return context.json({
      salt: await keys.saltFor(target.id),
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
    needLongPassphrase(unlock);
    if (!keys.pendingRewraps().includes(target.id)) throw new TargetError(409, "this target does not need a re-wrap");
    await keys.rewrapWithRecovery(target.id, code, unlock);
    audit(`audit ssh rewrap user=${logToken(options.user(context))} target=${logToken(target.id)}`);
    return context.body(null, 204);
  });

  hono.post("/targets/:id/key", async (context) => {
    const target = needTarget(context);
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    if (hasKey(target.id)) throw new TargetError(409, "the target has a key already");
    const sources = sourcesOf(target);
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");

    // All keys share one passphrase, so a typo would make a key that no one opens: check it against a key that exists.
    // A passkey makes another secret for each target (each has its own salt), so there is nothing to check against.
    const other =
      keys.method() === "passphrase"
        ? targets.list().find((item) => item.id !== target.id && hasOpenKey(item.id))
        : undefined;

    if (other) (await keys.open(other.id, unlock)).destroy();
    else needLongPassphrase(unlock);

    const made = await keys.create(target.id, unlock);
    await targets.setKeyFingerprint(target.id, made.fingerprint);
    return context.json({
      publicLine: made.publicLine,
      fingerprint: made.fingerprint,
      installLine: authorizedKeysLine(made.publicLine, sources),
      notes: installNotes(target.systemType),
    });
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

  hono.post("/grants/:id/approve", async (context) => {
    const body = await readObject(context);
    const unlock = parseUnlock(context, body.unlock);
    if (body.minutes !== undefined && typeof body.minutes !== "number")
      throw new HttpError(400, "minutes must be a number");
    const grant = await service.approve(context.req.param("id"), options.user(context), unlock, body.minutes);
    return context.json(projection(grant));
  });

  hono.post("/grants/:id/deny", (context) =>
    context.json(projection(grants.deny(context.req.param("id"), options.user(context)))),
  );

  hono.post("/grants/:id/revoke", async (context) =>
    context.json(projection(await service.revoke(context.req.param("id"), options.user(context)))),
  );

  return hono;
}
