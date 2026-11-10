/** Most bytes one unfinished line or one unfinished event may hold. More is a protocol error. */
export const MAX_SSE_BYTES = 1024 * 1024;

export type SseEvent = { event: string; data: string };

/**
 * Reads a Server-Sent Events body. Skips comment lines, joins `data:` lines with `\n`, and accepts `\n`, `\r\n`
 * and `\r` line ends. The default event name is `message`. When the caller stops iterating, the reader is
 * cancelled so the connection closes. `onActivity` runs each time bytes arrive, even when they hold only comments,
 * so a caller can tell a silent connection from a quiet one. This file has no server-only imports: the CLI may reuse it.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, o: { onActivity?: () => void } = {}): AsyncGenerator<SseEvent> {
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
    const i = line.indexOf(":");
    const name = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") event = value;
    else if (name === "data") {
      dataLen += value.length + 1;
      if (dataLen > MAX_SSE_BYTES) throw new Error("SSE event too large");
      data.push(value);
      sawData = true;
    }
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      o.onActivity?.();
      buf += decoder.decode(value, { stream: true });
      let start = 0;
      let i = scan;
      for (; i < buf.length; i++) {
        const ch = buf[i];
        if (ch !== "\n" && ch !== "\r") continue;
        let end = i + 1;
        if (ch === "\r") {
          // A lone trailing \r may be the first half of \r\n, so wait for the next chunk.
          if (i + 1 >= buf.length) break;
          if (buf[i + 1] === "\n") end++;
        }
        const ev = field(buf.slice(start, i));
        start = end;
        i = end - 1;
        if (ev) yield ev;
      }
      buf = buf.slice(start);
      scan = i - start;
      if (buf.length > MAX_SSE_BYTES) throw new Error("SSE line too large");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
