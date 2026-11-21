/** Most bytes one unfinished line or one unfinished event may hold. More is a protocol error. */
export const MAX_SSE_BYTES = 1024 * 1024;

/** The stream broke a rule of the format (a size cap). A network error is not one. */
export class SseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseProtocolError";
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Reads a Server-Sent Events body. Skips comment lines, joins `data:` lines with `\n`, and accepts `\n`, `\r\n`
 * and `\r` line ends. The default event name is `message`. When the caller stops iterating, the reader is
 * cancelled so the connection closes. `onActivity` runs each time bytes arrive, even when they hold only comments,
 * so a caller can tell a silent connection from a quiet one. This file has no server-only imports: the CLI may reuse it.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  options: { onActivity?: () => void } = {},
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let sawData = false;
  let dataLen = 0;
  let scan = 0;

  const take = (): SseEvent | null => {
    const out = sawData ? { event: event || "message", data: data.join("\n") } : null;
    event = "";
    data = [];
    sawData = false;
    dataLen = 0;
    return out;
  };

  const field = (line: string): SseEvent | null => {
    if (line === "") return take();
    if (line.startsWith(":")) return null;
    const position = line.indexOf(":");
    const name = position < 0 ? line : line.slice(0, position);
    let value = position < 0 ? "" : line.slice(position + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (name === "event") event = value;
    else if (name === "data") {
      dataLen += value.length + 1;
      if (dataLen > MAX_SSE_BYTES) throw new SseProtocolError("SSE event too large");
      data.push(value);
      sawData = true;
    }

    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onActivity?.();
      buf += decoder.decode(value, { stream: true });
      let start = 0;
      let entry = scan;

      for (; entry < buf.length; entry++) {
        const ch = buf[entry];
        if (ch !== "\n" && ch !== "\r") continue;
        let end = entry + 1;

        if (ch === "\r") {
          // A lone trailing \r may be the first half of \r\n, so wait for the next chunk.
          if (entry + 1 >= buf.length) break;
          if (buf[entry + 1] === "\n") end++;
        }

        const ev = field(buf.slice(start, entry));
        start = end;
        entry = end - 1;
        if (ev) yield ev;
      }

      buf = buf.slice(start);
      scan = entry - start;
      if (buf.length > MAX_SSE_BYTES) throw new SseProtocolError("SSE line too large");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
