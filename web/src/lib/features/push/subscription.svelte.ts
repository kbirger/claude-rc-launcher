import { getKey, subscribe, unsubscribe } from "./api";

/** The routes of the hub that the subscription uses. A test can pass its own. */
export type PushApi = {
  getKey: typeof getKey;
  subscribe: typeof subscribe;
  unsubscribe: typeof unsubscribe;
};

/** True when this browser can receive push notifications. */
export const pushSupported = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof globalThis.PushManager !== "undefined" &&
  typeof globalThis.Notification !== "undefined";

/** The key of the hub is base64url text. The browser wants the bytes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

// The push subscription of this browser, which makes it receive a notification for each SSH request. NotifySwitch only
// draws this. The state is on when a subscription exists and the permission is not denied. Call `sync` once on mount.
export function createPushSubscriptionModel(api: PushApi = { getKey, subscribe, unsubscribe }) {
  const supported = pushSupported();
  let on = $state(false);
  let busy = $state(false);
  let denied = $state(typeof Notification !== "undefined" && Notification.permission === "denied");
  let problem = $state("");

  const registration = () => navigator.serviceWorker.ready;

  async function turnOn() {
    if (Notification.permission !== "granted") {
      const answer = await Notification.requestPermission();

      if (answer !== "granted") {
        denied = answer === "denied";
        throw new Error("Notifications are not allowed for this site.");
      }
    }

    const { key } = await api.getKey();
    const item = await registration();
    const subscription = await item.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    });

    try {
      await api.subscribe(subscription.toJSON());
    } catch (error) {
      // The hub does not know this subscription, so the browser must not keep it.
      await subscription.unsubscribe().catch(() => false);
      throw error;
    }
  }

  async function turnOff() {
    const item = await registration();
    const subscription = await item.pushManager.getSubscription();
    if (!subscription) return;
    const { endpoint } = subscription;
    // The hub first: when it fails, the browser keeps its subscription and the switch stays on.
    await api.unsubscribe(endpoint).catch((error: unknown) => {
      // The hub has no record of it: that is the wanted end state.
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    });
    await subscription.unsubscribe();
  }

  return {
    supported,
    get on() {
      return on;
    },
    get busy() {
      return busy;
    },
    get denied() {
      return denied;
    },
    get problem() {
      return problem;
    },

    /** Reads the subscription of the browser. The hub can have lost this device, so it is registered again. */
    sync(): Promise<void> {
      if (!supported) return Promise.resolve();
      return registration()
        .then((item) => item.pushManager.getSubscription())
        .then((item) => {
          on = item !== null && !denied;
          // The hub can have lost this device (device cap, a move to another user, a deleted file, a new key).
          // Register it again in the background. The endpoint is the key, so this is safe to repeat.
          if (item && Notification.permission === "granted") void api.subscribe(item.toJSON()).catch(() => {});
        })
        .catch(() => {
          on = false;
        });
    },

    /** Turns the subscription on or off. Returns the state after the change: the old one when it failed. */
    async change(want: boolean): Promise<boolean> {
      busy = true;
      problem = "";

      try {
        await (want ? turnOn() : turnOff());
        on = want;
      } catch (error) {
        problem = error instanceof Error ? error.message : "The change failed.";
      } finally {
        busy = false;
      }

      return on;
    },
  };
}
