/** Distance in pixels the indicator moves for a drag, so the pull feels heavy. */
export const RESISTANCE = 0.5;
/** Indicator distance at which a release starts a refresh. */
export const THRESHOLD = 64;
/** The indicator never moves farther than this. */
export const MAX_PULL = 96;

/** Indicator distance for a finger that moved `dy` pixels down. Zero for an upward move. */
export function pullDistance(dy: number): number {
  return dy <= 0 ? 0 : Math.min(MAX_PULL, dy * RESISTANCE);
}

export const shouldRefresh = (pull: number): boolean => pull >= THRESHOLD;

/** The parts of an element that the check reads. */
type PullNode = { scrollTop: number; getAttribute(name: string): string | null; parentElement: PullNode | null };

/**
 * A pull starts only when the page is at its top and nothing under the finger can still scroll up.
 * A scrollable area that is not at its top keeps the swipe for itself, and so does an open dialog.
 */
export function canStartPull(target: unknown, pageScrollY: number): boolean {
  if (pageScrollY > 0) return false;
  for (let el = target as PullNode | null; el; el = el.parentElement) {
    if (el.scrollTop > 0) return false;
    if (el.getAttribute("role") === "dialog") return false;
  }
  return true;
}
