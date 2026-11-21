import type { UpdateEntry } from "./api";

/** The repository of the releases. The web app cannot import server code, so the value is repeated here. */
export const RELEASE_REPO = "kbirger/claude-rc-launcher";

/** The versions to read notes for: only an update that really moved to another version has a range. */
export function notesRange(updateEntry: UpdateEntry): { from: string; to: string } | undefined {
  if (updateEntry.status !== "updated" || !updateEntry.from || !updateEntry.to || updateEntry.from === updateEntry.to)
    return undefined;
  return { from: updateEntry.from, to: updateEntry.to };
}

/** The GitHub page of one release. A leading `v` of the version is removed first. */
export const releasePageUrl = (version: string): string =>
  `https://github.com/${RELEASE_REPO}/releases/tag/v${version.replace(/^v/, "")}`;
