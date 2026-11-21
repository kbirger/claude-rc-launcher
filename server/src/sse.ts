import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";

type Streams = Set<SSEStreamingApi>;
const registries = new WeakMap<object, Streams>();
const KEY = "sseStreams";

/** Makes `app` track its open SSE responses. Call it before the routes are added. */
export function trackStreams(app: Hono): void {
  const set: Streams = new Set();
  registries.set(app, set);
  app.use("*", async (context, next) => {
    context.set(KEY as never, set as never);
    await next();
  });
}

/**
 * An SSE response. Hono adds `Transfer-Encoding` and `Connection`. HTTP/2 forbids them, and a proxy that forwards them
 * to a browser causes ERR_HTTP2_PROTOCOL_ERROR. Bun frames the body itself, so the response needs neither.
 * An app that called `trackStreams` can end its open streams cleanly (see `stopServer`).
 */
export function sseResponse(context: Context, run: (stream: SSEStreamingApi) => Promise<void>): Response {
  const set = context.get(KEY as never) as Streams | undefined;
  const res = streamSSE(context, async (stream) => {
    set?.add(stream);

    try {
      await run(stream);
    } finally {
      set?.delete(stream);
    }
  });
  res.headers.delete("Transfer-Encoding");
  res.headers.delete("Connection");
  return res;
}

/** Ends every open SSE response of `app` with a proper end of body. */
export function closeStreams(app: Hono): void {
  for (const stream of [...(registries.get(app) ?? [])]) void stream.close().catch(() => {});
}

/**
 * Stops a server without cutting a stream in the middle. A cut stream reaches a browser behind an HTTP/2 proxy as
 * ERR_HTTP2_PROTOCOL_ERROR. The streams of `app` end first and the server stops taking requests. The connections that
 * are still open after `forceMs` are closed.
 */
export function stopServer(server: { stop(force?: boolean): unknown }, app: Hono, forceMs = 2000): void {
  closeStreams(app);
  void server.stop();
  const timer = setTimeout(() => void server.stop(true), forceMs) as { unref?: () => void };
  timer.unref?.();
}
