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
