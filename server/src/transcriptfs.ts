/*
 * The transcript file system seam: how session transcripts are listed, read line by line and read from the tail.
 * The default uses the real file system. Tests inject their own. See docs/session-files.md.
 */
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";

export type TranscriptFs = {
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<{ mtimeMs: number; size?: number }>;
  lines(p: string): AsyncIterable<string>;
  /** The complete lines in the last `bytes` bytes of the file (the first, partial line is dropped). Optional: without it only the head is read. */
  tail?(p: string, bytes: number): Promise<string[]>;
};

const MAX_LINE = 1024 * 1024;

/**
 * Stream a file line by line. A line over 1 MB is dropped without being kept in memory.
 * This runs on the main thread. The chunks are read without blocking, so the event loop gets a turn between them.
 * The measured cost and the proposed threading decision are in docs/session-files.md ("Cost and threading").
 */
async function* streamLines(p: string): AsyncIterable<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  for await (const chunk of createReadStream(p) as AsyncIterable<Buffer>) {
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!skipping) {
        size += end - start;
        if (size > MAX_LINE) {
          skipping = true;
          parts = [];
        } else if (end > start) {
          parts.push(chunk.subarray(start, end));
        }
      }
      if (nl === -1) break;
      if (!skipping) yield Buffer.concat(parts).toString("utf8");
      parts = [];
      size = 0;
      skipping = false;
      start = nl + 1;
    }
  }
  if (!skipping && size > 0) yield Buffer.concat(parts).toString("utf8");
}

/**
 * The complete lines in the last `bytes` bytes. A positional read: the rest of the file stays unread.
 * Why a byte window and not a number of lines: neither Bun nor Node has a built-in "last N lines". Reading a fixed
 * window from the end is the standard approach, and its cost does not depend on how long the lines are. The window
 * usually starts in the middle of a line, so that first partial line is dropped.
 */
async function tailLines(p: string, bytes: number): Promise<string[]> {
  const fh = await open(p, "r");
  try {
    const size = (await fh.stat()).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = await fh.read(buf, got, n - got, size - n + got);
      if (r.bytesRead === 0) break;
      got += r.bytesRead;
    }
    let text = buf.subarray(0, got);
    if (size > n) {
      const nl = text.indexOf(0x0a);
      text = nl === -1 ? text.subarray(got) : text.subarray(nl + 1);
    }
    return text.toString("utf8").split("\n");
  } finally {
    await fh.close();
  }
}

export const defaultTranscriptFs: TranscriptFs = {
  readdir: (dir) => readdir(dir),
  stat: (p) => stat(p),
  lines: streamLines,
  tail: tailLines,
};
