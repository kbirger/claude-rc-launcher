import type { UpdateEntry } from "./api";

/** The repository of the releases. The web app cannot import server code, so the value is repeated here. */
export const RELEASE_REPO = "kbirger/claude-rc-launcher";

/** The versions to read notes for: only an update that really moved to another version has a range. */
export function notesRange(e: UpdateEntry): { from: string; to: string } | undefined {
  if (e.status !== "updated" || !e.from || !e.to || e.from === e.to) return undefined;
  return { from: e.from, to: e.to };
}

/** The GitHub page of one release. A leading `v` of the version is removed first. */
export const releasePageUrl = (version: string): string => `https://github.com/${RELEASE_REPO}/releases/tag/v${version.replace(/^v/, "")}`;
