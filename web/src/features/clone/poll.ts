// Poll a job until it reaches a terminal state. One request at a time. A failed request is retried on the
// next tick; the poll gives up after maxFailures failures in a row, or at once on a 404 (unknown job).
// The timer functions are parameters so tests can use a fake clock.
export type PollOptions<T> = {
  fetch: () => Promise<T>;
  interval: number;
  maxFailures: number;
  // Return true when the result is terminal: polling then stops.
  onResult: (result: T) => boolean | void;
  onGiveUp: (error: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => any;
  clearTimeout?: (id: any) => void;
};

export function startPolling<T>(o: PollOptions<T>): () => void {
  const set = o.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clear = o.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  let stopped = false;
  let failures = 0;
  let timer: any;

  const schedule = () => {
    timer = set(tick, o.interval);
  };
  const tick = async () => {
    timer = undefined;
    let result: T;
    try {
      result = await o.fetch();
    } catch (e) {
      if (stopped) return;
      failures++;
      if ((e as any)?.status === 404 || failures >= o.maxFailures) {
        stopped = true;
        o.onGiveUp(e);
      } else schedule();
      return;
    }
    if (stopped) return;
    failures = 0;
    if (o.onResult(result) === true) stopped = true;
    else if (!stopped) schedule();
  };
  schedule();

  return () => {
    stopped = true;
    if (timer !== undefined) clear(timer);
    timer = undefined;
  };
}
