export type SseEvent = { event: string; data: string };

/**
 * Reads a Server-Sent Events body. Skips comment lines, joins `data:` lines with `\n`, and accepts `\n`, `\r\n`
 * and `\r` line ends. The default event name is `message`. When the caller stops iterating, the reader is
 * cancelled so the connection closes. This file has no server-only imports: the CLI may reuse it.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let sawData = false;
  const take = (): SseEvent | null => {
    const out = sawData ? { event: event || "message", data: data.join("\n") } : null;
    event = "";
    data = [];
    sawData = false;
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
      data.push(value);
      sawData = true;
    }
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        // A lone trailing \r may be the first half of \r\n, so wait for the next chunk.
        const m = /\r\n|\n|\r(?=.)/s.exec(buf);
        if (!m) break;
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = field(line);
        if (ev) yield ev;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
