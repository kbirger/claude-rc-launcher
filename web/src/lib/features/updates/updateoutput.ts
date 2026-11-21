import type { HostInfo } from "../hosts";
import type { UpdateEntry } from "./api";

/** The step of a running entry as text: `installing` or `installing-client: C:\...`. Empty when there is no step. */
export function stepText(updateEntry: UpdateEntry): string {
  if (!updateEntry.step) return "";
  return updateEntry.stepDetail ? `${updateEntry.step}: ${updateEntry.stepDetail}` : updateEntry.step;
}

export const stepIsError = (updateEntry: UpdateEntry): boolean => updateEntry.step === "failed";

/** A finished update that no banner item shows (the banner shows a panel for running and failed ones) gets its own closed panel. */
export const showsFinishedPanel = (updateEntry: UpdateEntry | undefined): boolean =>
  updateEntry?.status === "updated" || updateEntry?.status === "up-to-date";

/** The panel is open by default only while the update runs. */
export const panelOpenByDefault = (updateEntry: UpdateEntry | undefined): boolean => updateEntry?.status === "running";

/** The panel follows new lines only when the reader is at (or within 24 px of) the bottom. */
export const followsBottom = (scrollTop: number, clientHeight: number, scrollHeight: number): boolean =>
  scrollHeight - scrollTop - clientHeight <= 24;

/** The summary of the output panel: `Output (1 line)`, `Output (2 lines)`. */
export const outputSummary = (lines: number): string => `Output (${lines} ${lines === 1 ? "line" : "lines"})`;

/** What the host picker shows in brackets for a host that is not ok: restarting always says so; offline and error show the reason. */
export function hostOptionLabel(hostInfo: HostInfo): string | undefined {
  if (hostInfo.status === "ok") return undefined;
  const why = hostInfo.status === "restarting" ? hostInfo.status : (hostInfo.error ?? hostInfo.status);
  return `${hostInfo.name} (${why})`;
}
