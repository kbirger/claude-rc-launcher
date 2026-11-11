import type { HostInfo } from "../hosts";
import type { UpdateEntry } from "./api";

/** The step of a running entry as text: `installing` or `installing-client: C:\...`. Empty when there is no step. */
export function stepText(e: UpdateEntry): string {
  if (!e.step) return "";
  return e.stepDetail ? `${e.step}: ${e.stepDetail}` : e.step;
}

export const stepIsError = (e: UpdateEntry): boolean => e.step === "failed";

/** A finished update that no banner item shows (the banner shows a panel for running and failed ones) gets its own closed panel. */
export const showsFinishedPanel = (e: UpdateEntry | undefined): boolean => e?.status === "updated" || e?.status === "up-to-date";

/** The panel is open by default only while the update runs. */
export const panelOpenByDefault = (e: UpdateEntry | undefined): boolean => e?.status === "running";

/** The panel follows new lines only when the reader is at (or within 24 px of) the bottom. */
export const followsBottom = (scrollTop: number, clientHeight: number, scrollHeight: number): boolean => scrollHeight - scrollTop - clientHeight <= 24;

/** The summary of the output panel: `Output (1 line)`, `Output (2 lines)`. */
export const outputSummary = (n: number): string => `Output (${n} ${n === 1 ? "line" : "lines"})`;

/** What the host picker shows in brackets for a host that is not ok: restarting always says so; offline and error show the reason. */
export function hostOptionLabel(h: HostInfo): string | undefined {
  if (h.status === "ok") return undefined;
  const why = h.status === "restarting" ? h.status : (h.error ?? h.status);
  return `${h.name} (${why})`;
}
