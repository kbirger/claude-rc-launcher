// Pure helpers for the push handlers of the service worker, so that tests can run them without a worker.

export type PushMessage = {
  title: string;
  body: string;
  url: string;
  tag: string;
  grantId?: string;
  close?: boolean;
};

export type ClickData = { url: string; grantId?: string };

/** The message of a push, or `undefined` when the text is not a JSON object with the needed fields. */
export function parsePush(data: string): PushMessage | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const item = parsed as Record<string, unknown>;
  if (typeof item.title !== "string" || typeof item.body !== "string") return undefined;
  if (typeof item.url !== "string" || typeof item.tag !== "string") return undefined;
  return {
    title: item.title,
    body: item.body,
    url: item.url,
    tag: item.tag,
    ...(typeof item.grantId === "string" ? { grantId: item.grantId } : {}),
    ...(item.close === true ? { close: true } : {}),
  };
}

export function notificationOptions(message: PushMessage): NotificationOptions {
  return {
    tag: message.tag,
    body: message.body,
    icon: "/icon-192.png",
    data: { url: message.url, ...(message.grantId ? { grantId: message.grantId } : {}) } satisfies ClickData,
    ...(message.grantId
      ? {
          actions: [
            { action: "open", title: "Open" },
            { action: "deny", title: "Deny" },
          ],
        }
      : {}),
  };
}

/** Deny needs a grant id. When the hub does not accept the deny, or the call fails, the owner sees the page. */
export async function handleClick(
  action: string,
  data: ClickData,
  deps: { deny: (grantId: string) => Promise<Response>; open: (url: string) => Promise<void> },
): Promise<void> {
  if (action === "deny" && data.grantId) {
    try {
      const answer = await deps.deny(data.grantId);
      if (answer.ok) return;
    } catch {
      /* fall through: open the page */
    }
  }

  await deps.open(data.url);
}
