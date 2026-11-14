import { ApiError, hostUrl, request } from "../../shared/http";

export type LayerScope = "user" | "project" | "local" | "legacy-local" | "managed";
export type Rule = {
  raw: string;
  list: "allow" | "ask" | "deny";
  tool: string;
  specifier?: string;
  scope: string;
  /** An allow rule that a deny or ask rule overrides. */
  shadowedBy?: { scope: string; list: "ask" | "deny"; raw: string };
};
/** `path` is null when the node cannot tell where Claude Code keeps the file. `reason` is set for `invalid` and `unknown-path`. */
export type Layer = {
  scope: LayerScope;
  path: string | null;
  writable: boolean;
  state: "ok" | "missing" | "invalid" | "unknown-path";
  reason?: string;
  hash?: string;
  /** The file that was really read, when it is not at `path` (a symlink in the name or in a folder). */
  resolvedPath?: string;
  rules: Rule[];
  warnings: string[];
};
export type PermissionLayers = { layers: Layer[] };
export type BlockReason = "needs_approval" | "user_rejected" | "classifier" | "deny_rule" | "safety_check";
export type BlockedCall = { id: string; at: string; tool: string; input: Record<string, unknown>; reason: BlockReason; text: string };

const instanceBase = (host: string, instance: string) => `${hostUrl(host)}/instances/${encodeURIComponent(instance)}`;
const sessionBase = (host: string, instance: string, session: string) => `${instanceBase(host, instance)}/sessions/${encodeURIComponent(session)}`;

export const getUserPermissions = (host: string, instance: string) => request<PermissionLayers>("GET", `${instanceBase(host, instance)}/permissions`);

export const getSessionPermissions = (host: string, instance: string, session: string) =>
  request<PermissionLayers>("GET", `${sessionBase(host, instance, session)}/permissions`);

export const getBlocked = (host: string, instance: string, session: string) => request<BlockedCall[]>("GET", `${sessionBase(host, instance, session)}/blocked`);

/** True when the node has no permissions feature (404 or 501). */
export const isUnsupported = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 501);

export type RuleEdit = { scope: "user" | "project" | "local"; list: "allow" | "ask" | "deny"; rule: string; expectedHash: string | null; nudge?: boolean };
/** Whether the session was told to try again. `sent: true` means the message was sent, not that the session took it up. */
export type NudgeResult = { sent: true } | { sent: false; reason: "not_live" | "socket_refused" | "send_failed" | "unsupported" };

const rulesUrl = (host: string, instance: string, session: string | undefined) =>
  `${session === undefined ? instanceBase(host, instance) : sessionBase(host, instance, session)}/permissions/rules`;

/** Adds a rule to one file. `expectedHash` is the hash of the file as the page saw it (null when the file does not exist). A changed file answers 409. */
export const addRule = (host: string, instance: string, session: string | undefined, e: RuleEdit) => request<Layer & { nudge?: NudgeResult }>("POST", rulesUrl(host, instance, session), e);

export const removeRule = (host: string, instance: string, session: string | undefined, e: RuleEdit) => request<Layer>("DELETE", rulesUrl(host, instance, session), e);
