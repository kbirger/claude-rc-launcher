import * as webpush from "web-push";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logToken } from "../roles";

// Web Push for SSH requests. The hub holds one VAPID key pair (`<dir>/vapid.json`) and the device subscriptions of its
// admins (`<dir>/subscriptions.json`). Both files have mode 600 in a folder with mode 700. A write goes through a
// temporary file that is created with O_EXCL, and then a rename. All writes run in one promise chain, so two calls
// cannot lose an entry. `send` never rejects: a push is a hint, and the request is still in the app.

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
  grantId?: string;
  close?: boolean;
}

export type PushTransport = (
  sub: PushSubscriptionJson,
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  options: { urgency: "high" | "normal" },
) => Promise<{ status: number }>;

const MAX_PER_USER = 20;
const MAX_BYTES = 1024 * 1024;
const VERSION = 1;
const TTL_SECONDS = 600;
const TIMEOUT_MS = 10_000;

interface Vapid {
  publicKey: string;
  privateKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubscription(value: unknown): value is PushSubscriptionJson {
  return (
    isRecord(value) &&
    typeof value.endpoint === "string" &&
    isRecord(value.keys) &&
    typeof value.keys.p256dh === "string" &&
    typeof value.keys.auth === "string"
  );
}

/** The default transport: `web-push` encrypts the payload (aes128gcm) and signs the VAPID header. */
const defaultTransport: PushTransport = async (sub, payload, vapid, options) => {
  try {
    const result = await webpush.sendNotification(sub, payload, {
      TTL: TTL_SECONDS,
      urgency: options.urgency,
      timeout: TIMEOUT_MS,
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    return { status: result.statusCode };
  } catch (error) {
    if (error instanceof webpush.WebPushError) return { status: error.statusCode };
    throw error;
  }
};

/** A subscription that the hub refuses because of its content. The API answers 400 for it and 500 for any other error. */
export class PushValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushValidationError";
  }
}

/** The error name, and the error code when there is one. It holds no key and no message text. */
function errorToken(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? `${error.name} code=${logToken(String(code))}`
    : error.name;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

export class PushService {
  private readonly dir: string;
  private readonly subject: string;
  private readonly transport: PushTransport;
  private readonly audit: (line: string) => void;
  private vapid?: Promise<Vapid>;
  private subs?: Map<string, PushSubscriptionJson[]>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: { dir: string; subject: string; transport?: PushTransport; audit?: (line: string) => void }) {
    this.dir = options.dir;
    this.subject = options.subject;
    this.transport = options.transport ?? defaultTransport;
    this.audit = options.audit ?? (() => {});
  }

  /** The VAPID public key (base64url) that the browser needs to subscribe. */
  async publicKey(): Promise<string> {
    return (await this.loadVapid()).publicKey;
  }

  /** Stores a device subscription of a user. The same endpoint replaces the old entry. At most 20 for each user. */
  async subscribe(userId: string, sub: PushSubscriptionJson): Promise<void> {
    let url: URL;

    try {
      url = new URL(sub.endpoint);
    } catch {
      throw new PushValidationError("the push endpoint is not a valid URL");
    }

    if (url.protocol !== "https:") throw new PushValidationError("the push endpoint must use https");
    if (!isSubscription(sub)) throw new PushValidationError("the push subscription needs keys");
    const entry: PushSubscriptionJson = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    };
    await this.exclusive(async () => {
      const subs = this.loadSubs();

      for (const [user, list] of subs) {
        const rest = list.filter((item) => item.endpoint !== entry.endpoint);
        if (rest.length !== list.length) subs.set(user, rest);
      }

      const list = [...(subs.get(userId) ?? []), entry];
      subs.set(userId, list.slice(-MAX_PER_USER));
      await this.saveSubs(subs);
    });
    this.audit(`audit push subscribe user=${logToken(userId)} host=${logToken(url.host)}`);
  }

  /** Removes an entry of this user. False when the user has no such entry. */
  async unsubscribe(userId: string, endpoint: string): Promise<boolean> {
    const removed = await this.exclusive(async () => {
      const subs = this.loadSubs();
      const list = subs.get(userId) ?? [];
      const rest = list.filter((item) => item.endpoint !== endpoint);
      if (rest.length === list.length) return false;
      subs.set(userId, rest);
      await this.saveSubs(subs);
      return true;
    });
    if (removed) this.audit(`audit push unsubscribe user=${logToken(userId)} host=${logToken(hostOf(endpoint))}`);
    return removed;
  }

  /** Sends the message to every stored subscription. A dead entry (404, 410) is deleted. Never rejects. */
  async send(message: PushMessage): Promise<void> {
    try {
      const vapid = { ...(await this.loadVapid()), subject: this.subject };
      const all = await this.exclusive(() => Promise.resolve([...this.loadSubs().values()].flat()));
      const payload = JSON.stringify(message);
      const dead = new Set<string>();
      await Promise.all(
        all.map(async (sub) => {
          const host = logToken(hostOf(sub.endpoint));

          try {
            const { status } = await this.transport(sub, payload, vapid, {
              urgency: message.close === true ? "normal" : "high",
            });
            if (status === 404 || status === 410) dead.add(sub.endpoint);
            this.audit(`audit push send host=${host} status=${status}`);
          } catch (error) {
            this.audit(`audit push send host=${host} failed=${logToken(errorToken(error))}`);
          }
        }),
      );

      if (dead.size > 0) {
        await this.exclusive(async () => {
          const subs = this.loadSubs();
          for (const [user, list] of subs)
            subs.set(
              user,
              list.filter((item) => !dead.has(item.endpoint)),
            );
          await this.saveSubs(subs);
        });
      }
    } catch (error) {
      this.audit(`audit push send failed=${logToken(errorToken(error))}`);
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  private loadVapid(): Promise<Vapid> {
    this.vapid ??= this.exclusive(async () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(this.dir, "vapid.json"), "utf8"));

        if (isRecord(parsed) && typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
          return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }

        throw new Error("vapid.json is not valid");
      } catch (error) {
        // Only a missing file makes a new pair. An unreadable or corrupt file must not be overwritten.
        if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      }

      const keys = webpush.generateVAPIDKeys();
      const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
      await this.writeFile("vapid.json", JSON.stringify({ version: VERSION, ...vapid }));
      return vapid;
    });
    this.vapid.catch(() => (this.vapid = undefined));
    return this.vapid;
  }

  /** The subscriptions in memory. The first call reads the file. A file that is missing, too big or not valid is empty. */
  private loadSubs(): Map<string, PushSubscriptionJson[]> {
    if (this.subs) return this.subs;
    const subs = new Map<string, PushSubscriptionJson[]>();

    try {
      const text = readFileSync(join(this.dir, "subscriptions.json"), "utf8");
      const parsed: unknown = text.length > MAX_BYTES ? undefined : JSON.parse(text);

      if (isRecord(parsed) && parsed.version === VERSION && isRecord(parsed.subscriptions)) {
        for (const [user, list] of Object.entries(parsed.subscriptions)) {
          if (Array.isArray(list)) subs.set(user, list.filter(isSubscription).slice(-MAX_PER_USER));
        }
      }
    } catch {
      // missing or not valid: empty
    }

    this.subs = subs;
    return subs;
  }

  private async saveSubs(subs: Map<string, PushSubscriptionJson[]>): Promise<void> {
    const subscriptions = Object.fromEntries([...subs].filter(([, list]) => list.length > 0));
    await this.writeFile("subscriptions.json", JSON.stringify({ version: VERSION, subscriptions }));
  }

  private async writeFile(name: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, name);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;

    try {
      await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
}
