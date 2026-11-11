import { ApiError } from "../../shared/http";

export type TrustPrompt = { path: string; user: string };

// What to send to startInstance. A trust start must use exactly the folder and user the prompt named,
// whatever the dialog shows now. A plain start uses the current folder and the chosen user.
export function trustStartArgs(
  prompt: TrustPrompt | null,
  listing: { path: string },
  user: string | undefined,
  addTrust: boolean,
): { path: string; user?: string; addTrust: boolean } {
  if (addTrust && prompt) return { path: prompt.path, user: prompt.user || undefined, addTrust: true };
  return { path: listing.path, user, addTrust: false };
}

export type StartErrorAction = { kind: "trust"; prompt: TrustPrompt } | { kind: "error"; message: string };

// What to do when a start fails. A 428 "untrusted" asks the user about trust for the folder and user the server named.
export function startErrorAction(e: unknown, fallback: { path: string; user: string }): StartErrorAction {
  if (e instanceof ApiError && e.status === 428 && e.body?.code === "untrusted") {
    return { kind: "trust", prompt: { path: e.body.path ?? fallback.path, user: e.body.user ?? fallback.user } };
  }
  return { kind: "error", message: e instanceof ApiError ? e.message : "Failed to start" };
}
