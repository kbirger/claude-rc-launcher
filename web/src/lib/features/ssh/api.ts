import { request } from "../../shared/http";

// One function for each route of the hub at `/api/ssh` (see `server/src/sshapi.ts`). No answer holds a secret except
// the recovery code of `setup`, which the caller must show once and drop.

export type UnlockMethod = "prf" | "passphrase";
export type SystemType = "linux" | "windows" | "synology" | "dropbear";
export type TargetState = "draft" | "ready" | "disabled";
export type GrantState = "pending" | "active" | "ended";
export type EndReason = "expired" | "revoked" | "denied" | "node-lost" | "target-disabled" | "hub-restart";

/** An unlock in a request body. `secret` is base64url text. */
export type Unlock = { method: UnlockMethod; secret: string };

export type NodeStatus = { host: string; enabled: boolean; sourceAddress: string };
export type SshStatus = {
  setUp: boolean;
  method?: UnlockMethod;
  credentialId?: string;
  /** Ids of the targets whose key needs one re-lock after a recovery. */
  pendingRewrap: string[];
  /** False when no target has a key yet: the next passphrase is a new one. */
  hasKeys?: boolean;
  nodes: NodeStatus[];
  /** Ids of the targets whose provisioner key needs one re-lock after a recovery. */
  pendingProvisionerRewrap?: string[];
};

export type Target = {
  id: string;
  address: string;
  port: number;
  account: string;
  systemType: SystemType;
  /** Host ids of the nodes that can reach the target. */
  nodes: string[];
  managedHost?: string;
  /** A managed linux or synology target only: the file in `~/.ssh` that holds the key line. Absent means `authorized_keys`. */
  keyFile?: string;
  /** The pinned host key, one line in the `known_hosts` format. */
  hostKey?: string;
  keyFingerprint?: string;
  /** An external target with an installed provisioner: its key, the script path and the source address it allows. */
  provisionerFingerprint?: string;
  provisionerScript?: string;
  provisionerSource?: string;
  state: TargetState;
};
export type NewTarget = {
  id: string;
  account: string;
  systemType: SystemType;
  nodes: string[];
  managedHost?: string;
  keyFile?: string;
  address?: string;
  port?: number;
};
export type TargetSalt = { salt: string; method?: UnlockMethod; credentialId?: string };
/** `notes`: the install steps for the system type of the target, as lines of text. */
export type KeyResult = { publicLine: string; fingerprint: string; installLine: string; notes: string[] };
export type TargetDetail = Target & { notes: string[] };
export type HostKeyLine = { line: string; fingerprint: string };
export type ProvisionScript = { shell: "sh" | "powershell"; script: string };
export type NodeAccess = NodeStatus & { pushed: boolean };
export type TestResult = { ok: boolean; error?: string };
export type MaintenanceAction = "install" | "sources" | "uninstall";
/** The work of a maintenance grant. The lists are plain strings: host ids and source addresses. */
export type Maintenance = {
  action: MaintenanceAction;
  fromNodes: string[];
  toNodes?: string[];
  fromSources: string[];
  toSources?: string[];
  result?: "done" | "failed";
  detail?: string;
  changed?: boolean;
  /** True once the hub started a step of the run on the target. A grant that ended without it changed nothing there. */
  started?: boolean;
};
export type Grant = {
  id: string;
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
  /** Set for a maintenance grant: a change of the key line on the target, approved with the provisioner key. */
  maintenance?: Maintenance;
};

const BASE = "/api/ssh";
const targetUrl = (id: string) => `${BASE}/targets/${encodeURIComponent(id)}`;
const grantUrl = (id: string) => `${BASE}/grants/${encodeURIComponent(id)}`;

export const getStatus = () => request<SshStatus>("GET", `${BASE}/status`);

/** Sets up the unlock method. The answer holds the recovery code, which the hub shows only once. */
export const setup = (body: { method: UnlockMethod; credentialId?: string }) =>
  request<{ recoveryCode: string }>("POST", `${BASE}/setup`, body);

/**
 * Starts a recovery with the recovery code: the hub switches to the new unlock method and answers with the targets
 * that need a re-lock. It also ends every active grant.
 */
export const beginRecovery = (body: { code: string; method: UnlockMethod; credentialId?: string }) =>
  request<{ targets: string[] }>("POST", `${BASE}/recovery/begin`, body);

export const putNode = (host: string, body: { enabled: boolean; sourceAddress: string }) =>
  request<NodeAccess>("PUT", `${BASE}/nodes/${encodeURIComponent(host)}`, body);

export const listTargets = () => request<Target[]>("GET", `${BASE}/targets`);
export const createTarget = (body: NewTarget) => request<Target>("POST", `${BASE}/targets`, body);
export const getTarget = (id: string) => request<TargetDetail>("GET", targetUrl(id));
export const patchTarget = (id: string, state: "disabled" | "draft") =>
  request<Target>("PATCH", targetUrl(id), { state });
/**
 * The answer to a change of the nodes. `installLine`: an external target with a key gets its new key line, which the
 * owner installs in place of the old one. `lineUpdated`: a managed target has its line changed on the machine.
 * `pushed` is false when a node could not be told.
 */
export type TargetNodesResult = Target & { installLine?: string; lineUpdated?: boolean; pushed?: boolean };
/** The 202 answer for a target with a provisioner: nothing has changed yet, and the owner approves the grant. */
export type MaintenanceAnswer = { maintenance: Grant };
export const isMaintenanceAnswer = (answer: unknown): answer is MaintenanceAnswer =>
  typeof answer === "object" && answer !== null && "maintenance" in answer && !("id" in answer);
/** The text that the hub adds to a 409 when the new list allows none of the addresses that work now. */
export const CONFIRM_NODES_SUFFIX = ": send it again with confirm";
/**
 * Replaces the nodes of a target. A managed target gets the new key line before the answer. A target with a provisioner
 * answers with a maintenance grant, and `confirm` answers the 409 about a list that locks out every address in use.
 */
export const patchTargetNodes = (id: string, nodes: string[], confirm = false) =>
  request<TargetNodesResult | MaintenanceAnswer>("PATCH", targetUrl(id), {
    nodes,
    ...(confirm ? { confirm: true } : {}),
  });
/** What a retire did to the key line on the target: removed, not on the target, not removable (failed) or external (manual). */
export type RetireLine = "removed" | "not-found" | "failed" | "manual";
export type RetireResult = {
  id: string;
  account: string;
  address: string;
  port: number;
  systemType: SystemType;
  managed: boolean;
  line: RetireLine;
  detail?: string;
  /** Set when a provisioner stays on the machine: the two comments that end the lines to remove. */
  comments?: string[];
  /** The path of the provisioner script on the machine, when the script stays. */
  script?: string;
};
/** A target with a provisioner answers 202 with a maintenance grant. `cleanup: "none"` retires at once. */
export const deleteTarget = (id: string, cleanup?: "none") =>
  request<RetireResult | MaintenanceAnswer>("DELETE", `${targetUrl(id)}${cleanup ? "?cleanup=none" : ""}`);
/** Puts the key line back on the target: the hub answers with a maintenance grant. */
export const reinstallTarget = (id: string) => request<MaintenanceAnswer>("POST", `${targetUrl(id)}/reinstall`);
/** Makes the provisioner key of an external target. The answer holds the public part only. */
export const createProvisionerKey = (id: string, unlock: Unlock) =>
  request<{ publicLine: string; fingerprint: string }>("POST", `${targetUrl(id)}/provisioner-key`, { unlock });

/** The salt of the unlock of one key slot of a target. `provisioner` is the slot that a maintenance grant uses. */
export const getSalt = (id: string, key: "main" | "provisioner" = "main") =>
  request<TargetSalt>("GET", `${targetUrl(id)}/salt${key === "provisioner" ? "?key=provisioner" : ""}`);
/** Re-locks the key of one target under the new unlock. The code is the recovery code. */
export const rewrapTarget = (id: string, body: { code: string; unlock: Unlock; key?: "provisioner" }) =>
  request<void>("POST", `${targetUrl(id)}/rewrap`, body);
export const createKey = (id: string, unlock: Unlock) => request<KeyResult>("POST", `${targetUrl(id)}/key`, { unlock });
export const scanHostKey = (id: string, node: string) =>
  request<{ keys: HostKeyLine[] }>("POST", `${targetUrl(id)}/scan`, { node });
export const pinHostKey = (id: string, hostKey: string) => request<Target>("POST", `${targetUrl(id)}/pin`, { hostKey });
export const pinManaged = (id: string) => request<{ keys: HostKeyLine[] }>("POST", `${targetUrl(id)}/pin-managed`);
export const getProvision = (id: string) => request<ProvisionScript>("GET", `${targetUrl(id)}/provision`);
/** `sshdCheck`: present when the install needs the sshd check. `skipped` when the node is not root or is older. */
export const authorizeManaged = (id: string) =>
  request<{ ok: true; sshdCheck?: "passed" | "skipped" }>("POST", `${targetUrl(id)}/authorize`);
export const testTarget = (id: string, node: string, unlock: Unlock) =>
  request<TestResult>("POST", `${targetUrl(id)}/test`, { node, unlock });

export const listGrants = () => request<Grant[]>("GET", `${BASE}/grants`);
/** The approve of an `uninstall` grant also answers `retired`: what the retire did to the lines on the machine. */
export type ApprovedGrant = Grant & { retired?: RetireResult };
export const approveGrant = (id: string, unlock: Unlock, minutes?: number) =>
  request<ApprovedGrant>("POST", `${grantUrl(id)}/approve`, { unlock, ...(minutes !== undefined ? { minutes } : {}) });
export const denyGrant = (id: string) => request<Grant>("POST", `${grantUrl(id)}/deny`);
export const revokeGrant = (id: string) => request<Grant>("POST", `${grantUrl(id)}/revoke`);
