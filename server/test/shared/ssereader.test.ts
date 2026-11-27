import { describe, expect, test } from "bun:test";
import { MAX_SSE_BYTES, readSse } from "../../src/shared/ssereader";
import type { SseEvent } from "../../src/shared/ssereader";
import { rejection } from "../support";

const enc = new TextEncoder();
const bodyOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(readableStreamDefaultController) {
      for (const chunk of chunks) readableStreamDefaultController.enqueue(enc.encode(chunk));
      readableStreamDefaultController.close();
    },
  });

const all = async (chunks: string[]) => {
  const out: SseEvent[] = [];
  for await (const sseEvent of readSse(bodyOf(chunks))) out.push(sseEvent);
  return out;
};

describe("readSse", () => {
  test("an event split across three chunks", async () => {
    expect(await all(["event: upd", 'ate\ndata: {"a"', ":1}\n\n"])).toEqual([{ event: "update", data: '{"a":1}' }]);
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
    const uint8Array = enc.encode("data: é\n\n");
    const readableStream = new ReadableStream<Uint8Array>({
      start(readableStreamDefaultController) {
        readableStreamDefaultController.enqueue(uint8Array.slice(0, 7));
        readableStreamDefaultController.enqueue(uint8Array.slice(7));
        readableStreamDefaultController.close();
      },
    });
    const out: SseEvent[] = [];
    for await (const sseEvent of readSse(readableStream)) out.push(sseEvent);
    expect(out).toEqual([{ event: "message", data: "é" }]);
  });
  test("breaking out cancels the stream", async () => {
    let cancelled = false;
    const readableStream = new ReadableStream<Uint8Array>({
      pull(readableStreamDefaultController) {
        readableStreamDefaultController.enqueue(enc.encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _unused of readSse(readableStream)) break;
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
    const readableStream = new ReadableStream<Uint8Array>({
      pull(readableStreamDefaultController) {
        readableStreamDefaultController.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(
      await rejection(
        (async () => {
          for await (const _unused of readSse(readableStream)) {
            /* none */
          }
        })(),
      ),
    ).toBeInstanceOf(Error);
    expect(cancelled).toBe(true);
  });
  test("endless data lines with no blank line throw", async () => {
    const chunk = enc.encode("data: " + "y".repeat(1000) + "\n");
    const readableStream = new ReadableStream<Uint8Array>({
      pull(readableStreamDefaultController) {
        readableStreamDefaultController.enqueue(chunk);
      },
    });
    expect(
      await rejection(
        (async () => {
          for await (const _unused of readSse(readableStream)) {
            /* none */
          }
        })(),
      ),
    ).toBeInstanceOf(Error);
  });
  test("a 500 KiB event across several chunks still works", async () => {
    const part = "z".repeat(100 * 1024);
    const out = await all(["data: ", part, part, part, part, part, "\n\n"]);
    expect(out.length).toBe(1);
    expect(out[0].data.length).toBe(500 * 1024);
    expect(500 * 1024).toBeLessThan(MAX_SSE_BYTES);
  });

  test("onActivity fires for every chunk, including chunks that hold only comments", async () => {
    let count = 0;
    const out: SseEvent[] = [];
    for await (const sseEvent of readSse(bodyOf([": keepalive\n\n", ": keepalive\n\n", "event: a\ndata: 1\n\n"]), {
      onActivity: () => count++,
    }))
      out.push(sseEvent);
    expect(out).toEqual([{ event: "a", data: "1" }]);
    expect(count).toBe(3);
  });
});
