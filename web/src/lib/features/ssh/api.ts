import { request } from "../../shared/http";

// One function for each route of the hub at `/api/ssh` (see `server/src/sshapi.ts`). No answer holds a secret except
// the recovery code of `setup`, which the caller must show once and drop.

export type UnlockMethod = "prf" | "passphrase";
export type SystemType = "linux" | "windows" | "synology" | "dropbear";
export type TargetState = "draft" | "ready" | "disabled" | "retired";
export type GrantState = "pending" | "active" | "ended";
export type EndReason = "expired" | "revoked" | "denied" | "node-lost" | "target-disabled" | "hub-restart";

/** An unlock in a request body. `secret` is base64url text. */
export type Unlock = { method: UnlockMethod; secret: string };

export type NodeStatus = { host: string; enabled: boolean; sourceAddress: string };
export type SshStatus = { setUp: boolean; method?: UnlockMethod; credentialId?: string; nodes: NodeStatus[] };

export type Target = {
  id: string;
  address: string;
  port: number;
  account: string;
  systemType: SystemType;
  /** Host ids of the nodes that can reach the target. */
  nodes: string[];
  managedHost?: string;
  /** The pinned host key, one line in the `known_hosts` format. */
  hostKey?: string;
  keyFingerprint?: string;
  state: TargetState;
};
export type NewTarget = {
  id: string;
  account: string;
  systemType: SystemType;
  nodes: string[];
  managedHost?: string;
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
};

const BASE = "/api/ssh";
const targetUrl = (id: string) => `${BASE}/targets/${encodeURIComponent(id)}`;
const grantUrl = (id: string) => `${BASE}/grants/${encodeURIComponent(id)}`;

export const getStatus = () => request<SshStatus>("GET", `${BASE}/status`);

/** Sets up the unlock method. The answer holds the recovery code, which the hub shows only once. */
export const setup = (body: { method: UnlockMethod; credentialId?: string }) =>
  request<{ recoveryCode: string }>("POST", `${BASE}/setup`, body);

export const putNode = (host: string, body: { enabled: boolean; sourceAddress: string }) =>
  request<NodeAccess>("PUT", `${BASE}/nodes/${encodeURIComponent(host)}`, body);

export const listTargets = () => request<Target[]>("GET", `${BASE}/targets`);
export const createTarget = (body: NewTarget) => request<Target>("POST", `${BASE}/targets`, body);
export const getTarget = (id: string) => request<TargetDetail>("GET", targetUrl(id));
export const patchTarget = (id: string, state: "disabled" | "draft") =>
  request<Target>("PATCH", targetUrl(id), { state });
export const deleteTarget = (id: string) => request<Target & { comment: string }>("DELETE", targetUrl(id));

export const getSalt = (id: string) => request<TargetSalt>("GET", `${targetUrl(id)}/salt`);
export const createKey = (id: string, unlock: Unlock) => request<KeyResult>("POST", `${targetUrl(id)}/key`, { unlock });
export const scanHostKey = (id: string, node: string) =>
  request<{ keys: HostKeyLine[] }>("POST", `${targetUrl(id)}/scan`, { node });
export const pinHostKey = (id: string, hostKey: string) => request<Target>("POST", `${targetUrl(id)}/pin`, { hostKey });
export const pinManaged = (id: string) => request<{ keys: HostKeyLine[] }>("POST", `${targetUrl(id)}/pin-managed`);
export const getProvision = (id: string) => request<ProvisionScript>("GET", `${targetUrl(id)}/provision`);
export const authorizeManaged = (id: string) => request<{ ok: true }>("POST", `${targetUrl(id)}/authorize`);
export const testTarget = (id: string, node: string, unlock: Unlock) =>
  request<TestResult>("POST", `${targetUrl(id)}/test`, { node, unlock });

export const listGrants = () => request<Grant[]>("GET", `${BASE}/grants`);
export const approveGrant = (id: string, unlock: Unlock, minutes?: number) =>
  request<Grant>("POST", `${grantUrl(id)}/approve`, { unlock, ...(minutes !== undefined ? { minutes } : {}) });
export const denyGrant = (id: string) => request<Grant>("POST", `${grantUrl(id)}/deny`);
export const revokeGrant = (id: string) => request<Grant>("POST", `${grantUrl(id)}/revoke`);
