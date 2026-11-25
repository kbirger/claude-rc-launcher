import { request } from "../../shared/http";

// The routes of the hub at `/api/push` (see `server/src/pushapi.ts`). They need an admin.

/** The public VAPID key, as base64url text. */
export const getKey = () => request<{ key: string }>("GET", "/api/push/key");
export const subscribe = (subscription: PushSubscriptionJSON) =>
  request<void>("POST", "/api/push/subscribe", subscription);
export const unsubscribe = (endpoint: string) => request<void>("POST", "/api/push/unsubscribe", { endpoint });
