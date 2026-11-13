/** A service that systemd reports as `inactive` was paused: its entry is kept so that it can be resumed. */
export const isPaused = (state: string): boolean => state === "inactive";

export const stateLabel = (state: string): string => (isPaused(state) ? "paused" : state);

export type Tone = "ok" | "failed" | "other";
export const stateTone = (state: string): Tone => (state === "active" ? "ok" : state === "failed" ? "failed" : "other");
