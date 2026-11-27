import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HttpError } from "./instances/InstanceService";
import { isObject, readObject } from "./shared/requests";
import { logToken } from "./roles";
import type { User } from "./auth/user";
import { PushValidationError } from "./webpush";
import type { PushService, PushSubscriptionJson } from "./webpush";

// The routes that register a device for push notifications, mounted at `/push` of the browser API and of the CLI API.
// `GET /key` gives the VAPID public key, `POST /subscribe` stores a device subscription of the caller and
// `POST /unsubscribe` removes one. Every write writes one audit line with the user and the path only: never the
// endpoint or the keys. The minimum role of each route is in `roles.ts`.

export interface PushApiOptions {
  push: PushService;
  /** The name of the user of the request. */
  user: (context: Context) => string;
  /** Where the audit lines go. Default: the console. */
  audit?: (line: string) => void;
}

const MAX_TEXT = 4096;

const field = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT) throw new HttpError(400, `${name} is required`);
  return value;
};

export function pushApi(options: PushApiOptions): Hono {
  const { push } = options;
  const audit =
    options.audit ??
    ((line: string) => {
      console.log(line);
    });
  const hono = new Hono();

  const auditWrites: MiddlewareHandler = async (context, next) => {
    await next();
    if (context.req.method === "GET" || context.req.method === "HEAD" || context.req.method === "OPTIONS") return;
    const user = context.get("user" as never) as User | undefined;
    audit(
      `audit user=${logToken(options.user(context))} role=${user?.role ?? "read"} push ${context.req.method} ${new URL(context.req.url).pathname} ${context.res.status}`,
    );
  };

  hono.use("*", auditWrites);

  hono.get("/key", async (context) => context.json({ key: await push.publicKey() }));

  hono.post("/subscribe", async (context) => {
    const body = await readObject(context);
    const keys = body.keys;
    if (!isObject(keys)) throw new HttpError(400, "keys are required");
    const sub: PushSubscriptionJson = {
      endpoint: field(body.endpoint, "endpoint"),
      keys: { p256dh: field(keys.p256dh, "keys.p256dh"), auth: field(keys.auth, "keys.auth") },
    };

    try {
      await push.subscribe(options.user(context), sub);
    } catch (error) {
      if (error instanceof PushValidationError) throw new HttpError(400, error.message);
      throw new HttpError(500, "the subscription could not be saved");
    }

    return context.body(null, 204);
  });

  hono.post("/unsubscribe", async (context) => {
    const body = await readObject(context);
    const removed = await push.unsubscribe(options.user(context), field(body.endpoint, "endpoint"));
    if (!removed) throw new HttpError(404, "no such subscription");
    return context.body(null, 204);
  });

  return hono;
}
