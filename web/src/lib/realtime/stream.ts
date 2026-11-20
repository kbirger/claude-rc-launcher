type Timer = ReturnType<typeof setTimeout>;

/** Whether the tab is hidden, and a way to hear when that changes. */
export type Visibility = { hidden(): boolean; onChange(fn: () => void): () => void };

/** The visibility of the page's document. Never hidden if there is no document (a test or a server). */
export const documentVisibility: Visibility = {
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  onChange(fn) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

/** How long a tab stays hidden before its streams close. A quick switch between tabs keeps them open. */
export const HIDDEN_CLOSE_MS = 30_000;

/**
 * Keeps one event stream open. When the browser gives up on it (readyState CLOSED), the stream is reopened after each
 * of `delays` in turn, and then on the next window focus. Any received message resets the retries.
 *
 * After `hiddenMs` in the hidden state, the stream closes and its retries stop. The next visible state opens it again
 * (`onOpen` then gets an `opens` above 1). A stream that closes while the tab is hidden waits for the visible state.
 * Returns the stop function.
 */
export function keepStream(o: {
  url: string;
  /** The name in the console lines, for example "event stream". */
  name: string;
  /** The handlers of the named events. Each call resets the retries. */
  listeners: Record<string, (data: string) => void>;
  /** Called at each open, with the count of opens so far (1 for the first). */
  onOpen?(opens: number): void;
  open?: (url: string) => EventSource;
  delays?: number[];
  setTimeout?: (f: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
  visibility?: Visibility;
  hiddenMs?: number;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}): () => void {
  const log = o.log ?? console;
  const open = o.open ?? ((u: string) => new EventSource(u));
  const delays = o.delays ?? [5000, 15000, 45000];
  const setT = o.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const clearT = o.clearTimeout ?? ((t) => clearTimeout(t));
  const visibility = o.visibility ?? documentVisibility;
  const hiddenMs = o.hiddenMs ?? HIDDEN_CLOSE_MS;
  let es: EventSource | undefined;
  let stopped = false;
  let waiting = false;
  // True while the stream is closed because of the hidden state. The next visible state opens it.
  let parked = false;
  let retries = 0;
  let timer: Timer | undefined;
  let hideTimer: Timer | undefined;
  let opens = 0;

  const clearTimer = () => {
    if (timer !== undefined) clearT(timer);
    timer = undefined;
  };
  const clearHideTimer = () => {
    if (hideTimer !== undefined) clearT(hideTimer);
    hideTimer = undefined;
  };

  const onFocus = () => {
    globalThis.removeEventListener("focus", onFocus);
    waiting = false;
    retries = 0;
    if (!stopped) connect();
  };

  // Closes the stream and drops the retries and the focus wait. The next visible state opens it again.
  const park = () => {
    parked = true;
    waiting = false;
    clearTimer();
    globalThis.removeEventListener("focus", onFocus);
    es?.close();
    es = undefined;
  };

  const connect = () => {
    clearTimer();
    es?.close();
    es = undefined;
    if (visibility.hidden()) {
      park();
      return;
    }
    const s = open(o.url);
    es = s;
    s.addEventListener("open", () => {
      retries = 0;
      opens++;
      log.info(`[claude-rc] ${o.name} open (open ${opens})`);
      o.onOpen?.(opens);
    });
    for (const [type, fn] of Object.entries(o.listeners)) {
      s.addEventListener(type, (e) => {
        retries = 0;
        fn(String((e as MessageEvent).data));
      });
    }
    s.addEventListener("error", () => {
      // CLOSED (2): the browser gave up (a 502 from a proxy while the hub restarts, a 401, a 501). CONNECTING (0): the browser retries itself.
      if (s.readyState !== 2) {
        log.info(`[claude-rc] ${o.name} error (ready state ${s.readyState}), the browser retries`);
        return;
      }
      if (stopped || waiting || parked || timer !== undefined || es !== s) return;
      log.warn(`[claude-rc] ${o.name} closed`);
      if (visibility.hidden()) {
        log.info(`[claude-rc] ${o.name} will reconnect when the tab is visible`);
        park();
        return;
      }
      if (retries < delays.length) {
        log.info(`[claude-rc] reconnect in ${delays[retries]! / 1000}s`);
        timer = setT(() => {
          timer = undefined;
          if (!stopped) connect();
        }, delays[retries++]!);
      } else {
        // The retries are used up (for example a real 401). Try once more on the next focus.
        waiting = true;
        log.warn("[claude-rc] retries used up, will reconnect on the next focus");
        globalThis.addEventListener("focus", onFocus);
      }
    });
  };

  const onVisibility = () => {
    if (stopped) return;
    if (visibility.hidden()) {
      if (hideTimer === undefined && !parked) {
        hideTimer = setT(() => {
          hideTimer = undefined;
          if (stopped || !visibility.hidden()) return;
          log.info(`[claude-rc] ${o.name} closed, the tab is hidden`);
          park();
        }, hiddenMs);
      }
      return;
    }
    clearHideTimer();
    if (parked) {
      parked = false;
      retries = 0;
      connect();
    }
  };

  const offVisibility = visibility.onChange(onVisibility);
  connect();
  return () => {
    stopped = true;
    offVisibility();
    clearTimer();
    clearHideTimer();
    globalThis.removeEventListener("focus", onFocus);
    es?.close();
    es = undefined;
  };
}
