import { ApiError } from "../../shared/http";
import type { SettingsPatch } from "../instances";

export type TrustPrompt = { path: string; user: string };
// What the dialog opens with after a 428: the folder, user, name and settings of that start, and its trust question.
// The settings are only the ones that start changed from the node defaults.
export type NewInitial = { path: string; user?: string; name?: string; settings?: SettingsPatch; trust: TrustPrompt };

// What to send to startInstance. A trust start must use exactly the folder and user the prompt named,
// whatever the dialog shows now, so it needs no listing. A plain start uses the current folder and the chosen user.
// Null when there is nothing to start: no listing yet, or the roots view.
export function trustStartArgs(
  prompt: TrustPrompt | null,
  listing: { path: string } | null,
  user: string | undefined,
  addTrust: boolean,
): { path: string; user?: string; addTrust: boolean } | null {
  if (addTrust) return prompt ? { path: prompt.path, user: prompt.user || undefined, addTrust: true } : null;
  if (!listing || listing.path === "") return null;
  return { path: listing.path, user, addTrust: false };
}

export type StartErrorAction = { kind: "trust"; prompt: TrustPrompt } | { kind: "error"; message: string };

// What to do when a start fails. A 428 "untrusted" asks the user about trust for the folder and user the server named.
export function startErrorAction(response: unknown, fallback: { path: string; user: string }): StartErrorAction {
  if (response instanceof ApiError && response.status === 428 && response.body?.code === "untrusted") {
    return {
      kind: "trust",
      prompt: {
        path: typeof response.body.path === "string" ? response.body.path : fallback.path,
        user: typeof response.body.user === "string" ? response.body.user : fallback.user,
      },
    };
  }

  return { kind: "error", message: response instanceof ApiError ? response.message : "Failed to start" };
}
