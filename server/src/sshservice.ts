import type { HostClient } from "./hostclient";
import { isObject } from "./requests";
import { logToken } from "./roles";
import { GrantError } from "./sshgrants";
import type { Grant, GrantStore } from "./sshgrants";
import { KeyError } from "./sshkeystore";
import type { SshKeyStore, UnlockSecret } from "./sshkeystore";
import { NO_WAITING_REQUEST } from "./sshnodeapi";
import { authorizedKeysLine, TargetError } from "./sshtargets";
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
}

const isOk = (status: number) => status >= 200 && status < 300;

/** The text of an error body (`{ error }`), for a message. */
function errorText(body: unknown, status: number): string {
  if (isObject(body) && typeof body.error === "string" && body.error) return body.error;
  return `the node answered with status ${status}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
   */
  async approve(grantId: string, by: string, unlock: UnlockSecret, minutes?: number): Promise<Grant> {
    const { grants, keys } = this.deps;
    const grant = grants.get(grantId);
    if (!grant) throw new GrantError(404, "no such grant");
    if (grant.state !== "pending") throw new GrantError(409, `grant is ${grant.state}`);
    const target = this.usableTarget(grant);
    if (!target.hostKey) throw new TargetError(409, "the host key of the target is not pinned");

    let key;

    try {
      key = await keys.open(grant.targetId, unlock);
    } catch (error) {
      if (error instanceof KeyError && error.code === "wrong-unlock")
        throw new GrantError(403, "the unlock does not open the key");
      throw error;
    }

    // The derive takes a while: a disable, a retire or a recovery begin can land meanwhile. Read the target again.
    try {
      this.usableTarget(grant);
      if (keys.pendingRewraps().includes(grant.targetId))
        throw new TargetError(409, "this target needs its key to be recovered");
    } catch (error) {
      key.destroy();
      throw error;
    }

    // The grant store holds the key from here, and destroys it when the grant ends. It destroys it at once if this fails.
    const publicKey = Buffer.from(key.publicBlob).toString("base64");
    const active = grants.approve(grantId, by, key, minutes);

    try {
      const reply = await this.nodeCall(active.nodeId, "POST", "/grants", {
        grantId: active.id,
        ...(active.requestId !== undefined ? { requestId: active.requestId } : {}),
        instanceId: active.instanceId,
        targetId: active.targetId,
        publicKey,
        address: target.address,
        port: target.port,
        account: target.account,
        hostKey: target.hostKey,
        endsAt: active.endsAt,
      });
      if (!isOk(reply.status)) throw new Error(errorText(reply.body, reply.status));
    } catch (error) {
      grants.endWhere((item) => item.id === grantId, "node-lost");
      if (error instanceof GrantError) throw error;
      // The owner reads this text on the approve sheet, so the node text becomes plain words.
      const text = message(error);
      throw new GrantError(409, text === NO_WAITING_REQUEST ? STOPPED_WAITING : text);
    }

    // The grant ended while the POST was in flight: its DELETE may have reached the node before the grant existed
    // there, and the node has no timer of its own. Tell the node again.
    if (grants.get(grantId)?.state !== "active") {
      void this.nodeCall(active.nodeId, "DELETE", `/grants/${active.id}`).catch((error: unknown) => {
        this.failed(active, message(error));
      });
    }

    return grants.get(grantId) ?? active;
  }

  /**
   * The target of a grant, if a grant may use it now: a `ready` target, or a `draft` target for the test grant that the
   * hub makes (`test`). A real grant never uses a target that has not passed its test.
   */
  private usableTarget(grant: Grant): Target {
    const target = this.deps.targets.get(grant.targetId);
    if (!target) throw new TargetError(404, "no such target");
    if (target.state !== "ready" && !(target.state === "draft" && grant.test))
      throw new TargetError(409, `the target is ${target.state}`);
    return target;
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

  /** Puts the key line of the target into the `authorized_keys` of the account, through the node that is the target. */
  async authorizeManaged(targetId: string): Promise<void> {
    const target = this.needManaged(targetId);
    const { keys, targets } = this.deps;
    const sources = targets.sourcesOf(target);
    if (sources.length === 0)
      throw new TargetError(409, "no node of this target has access enabled with a source address");
    const line = authorizedKeysLine(keys.publicLine(targetId), sources);
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
