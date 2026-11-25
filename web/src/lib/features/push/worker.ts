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

/**
 * A link that stays on this site: one `/` and then a path. Anything else (another origin, `//host`, `/\host`, a
 * `javascript:` link, text that is not a link) becomes `/ssh`, so that a push can never open another site.
 */
export function safeUrl(url: unknown): string {
  if (typeof url !== "string" || !url.startsWith("/") || url[1] === "/" || url[1] === "\\") return "/ssh";
  const base = "https://site.invalid";

  try {
    return new URL(url, base).origin === base ? url : "/ssh";
  } catch {
    return "/ssh";
  }
}

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
  if (typeof item.tag !== "string") return undefined;
  return {
    title: item.title,
    body: item.body,
    url: safeUrl(item.url),
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
    data: { url: safeUrl(message.url), ...(message.grantId ? { grantId: message.grantId } : {}) } satisfies ClickData,
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

  await deps.open(safeUrl(data.url));
}

/** The part of the service worker registration that `showPush` needs. */
export type RegistrationLike = {
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
  getNotifications: (filter?: { tag?: string }) => Promise<{ close: () => void }[]>;
};

/**
 * Shows a push. A `close` message shows a quiet notification with the same tag (Chrome requires a visible one for
 * each push) and then closes every notification of that tag, the new one and the earlier request.
 */
export async function showPush(message: PushMessage, registration: RegistrationLike): Promise<void> {
  if (!message.close) {
    await registration.showNotification(message.title, notificationOptions(message));
    return;
  }

  // The lookup can fail. Close what we can find before and after the quiet one, retry once, and never reject.
  const closeAll = async (): Promise<boolean> => {
    try {
      for (const item of await registration.getNotifications({ tag: message.tag })) item.close();
      return true;
    } catch {
      return false;
    }
  };

  await closeAll();

  try {
    await registration.showNotification(message.title, { tag: message.tag, silent: true, icon: "/icon-192.png" });
  } catch {
    return;
  }

  if (!(await closeAll())) await closeAll();
}
