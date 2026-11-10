import { describe, expect, test } from "bun:test";
import { MAX_SSE_BYTES, readSse, type SseEvent } from "../src/ssereader";

const enc = new TextEncoder();
const bodyOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
const all = async (chunks: string[]) => {
  const out: SseEvent[] = [];
  for await (const e of readSse(bodyOf(chunks))) out.push(e);
  return out;
};

describe("readSse", () => {
  test("an event split across three chunks", async () => {
    expect(await all(["event: upd", "ate\ndata: {\"a\"", ":1}\n\n"])).toEqual([{ event: "update", data: '{"a":1}' }]);
  });
  test("comments are ignored", async () => {
    expect(await all([": keepalive\n\n", ": hi\ndata: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });
  test("two data lines join with a newline", async () => {
    expect(await all(["data: a\ndata: b\n\n"])).toEqual([{ event: "message", data: "a\nb" }]);
  });
  test("CRLF line ends, also split between chunks", async () => {
    expect(await all(["event: log\r\ndata: 1\r", "\n\r\n", "data: 2\r\n\r\n"])).toEqual([
      { event: "log", data: "1" },
      { event: "message", data: "2" },
    ]);
  });
  test("a multi-byte character split between chunks survives", async () => {
    const b = enc.encode("data: é\n\n");
    const s = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b.slice(0, 7)); c.enqueue(b.slice(7)); c.close(); } });
    const out: SseEvent[] = [];
    for await (const e of readSse(s)) out.push(e);
    expect(out).toEqual([{ event: "message", data: "é" }]);
  });
  test("breaking out cancels the stream", async () => {
    let cancelled = false;
    const s = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enc.encode("data: x\n\n")); },
      cancel() { cancelled = true; },
    });
    for await (const _ of readSse(s)) break;
    expect(cancelled).toBe(true);
  });
  test("a lone CR ends a line; data without a space; a field line with no colon", async () => {
    expect(await all(["data:a\rdata\r\revent: e\rdata:b\r\rdata: z\n\n"])).toEqual([
      { event: "message", data: "a\n" },
      { event: "e", data: "b" },
      { event: "message", data: "z" },
    ]);
  });
  test("a newline-free stream over the limit throws and cancels", async () => {
    let cancelled = false;
    const chunk = enc.encode("x".repeat(64 * 1024));
    const s = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(chunk); }, cancel() { cancelled = true; } });
    await expect((async () => { for await (const _ of readSse(s)) { /* none */ } })()).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  test("endless data lines with no blank line throw", async () => {
    const chunk = enc.encode("data: " + "y".repeat(1000) + "\n");
    const s = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(chunk); } });
    await expect((async () => { for await (const _ of readSse(s)) { /* none */ } })()).rejects.toThrow();
  });
  test("a 500 KiB event across several chunks still works", async () => {
    const part = "z".repeat(100 * 1024);
    const out = await all(["data: ", part, part, part, part, part, "\n\n"]);
    expect(out.length).toBe(1);
    expect(out[0]!.data.length).toBe(500 * 1024);
    expect(500 * 1024).toBeLessThan(MAX_SSE_BYTES);
  });
});
