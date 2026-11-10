import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";

/**
 * An SSE response. Hono adds `Transfer-Encoding` and `Connection`. HTTP/2 forbids them, and a proxy that forwards them
 * to a browser causes ERR_HTTP2_PROTOCOL_ERROR. Bun frames the body itself, so the response needs neither.
 */
export function sseResponse(c: Context, run: (s: SSEStreamingApi) => Promise<void>): Response {
  const res = streamSSE(c, run);
  res.headers.delete("Transfer-Encoding");
  res.headers.delete("Connection");
  return res;
}
