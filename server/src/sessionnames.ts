/*
 * The name of a session, read from its transcript. This file only READS TRANSCRIPTS. See docs/session-files.md.
 * readName reads from the start up to the first real prompt (at most 256 KB), and the last 256 KB for title
 * records. Its result is cached by file size and modification time.
 */
import { parse } from "./transcript";
import type { TranscriptFs } from "./transcriptfs";
import type { Found } from "./sessionscan";

/**
 * Where a name came from. The order of trust is `live` and `custom` (someone set it, it is what the app shows), then
 * `ai`, then `agent`, then `prompt` (the first real prompt), then `default` (made by Claude Code, last resort).
 */
export type NameSource = "live" | "custom" | "ai" | "agent" | "prompt" | "default";
export const NAME_RANK: Record<NameSource, number> = { live: 4, custom: 4, ai: 3, agent: 2, prompt: 1, default: 0 };
export type NameInfo = { name: string; source: NameSource };

type CacheValue = { size: number | undefined; mtimeMs: number; name: string | undefined; source?: NameSource };
export type NameCache = {
  get(file: string): CacheValue | undefined;
  set(file: string, v: CacheValue): void;
};

/** A bounded map: when full, the oldest entry goes. */
export function newNameCache(max = 2000): NameCache {
  const m = new Map<string, CacheValue>();
  return {
    get: (f) => m.get(f),
    set(f, v) {
      m.delete(f);
      m.set(f, v);
      while (m.size > max) m.delete(m.keys().next().value as string);
    },
  };
}

const NAME_WINDOW = 256 * 1024;
const NAME_MAX = 80;

const NOT_PROMPT = ["<command-name>", "<local-command", "<system-reminder", "<command-message", "Caveat:", "[Request interrupted"];

/** The text of a real user prompt, or undefined for meta records, command echoes and system messages. */
function promptText(r: Record<string, any>): string | undefined {
  if (r.type !== "user" || r.isMeta === true) return undefined;
  const c = r.message?.content;
  let text: unknown = c;
  if (Array.isArray(c)) text = c.find((b) => b && b.type === "text" && typeof b.text === "string")?.text;
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (t.length === 0 || NOT_PROMPT.some((p) => t.startsWith(p))) return undefined;
  return t;
}

export function tidy(raw: string | undefined): string | undefined {
  // Drop format and control characters (bidi overrides, zero-width characters) and collapse whitespace, so that a
  // name cannot look like another one. A joined emoji (it uses U+200D) is shown as its parts.
  // Format characters go first, because \s also matches U+FEFF. Control characters go after the collapse, so that a
  // tab or a line feed still becomes a space.
  const t = (raw ?? "").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").replace(/ {2,}/g, " ").trim();
  if (t.length === 0) return undefined;
  // Cut on code points, not UTF-16 units, so that an emoji is never split in half.
  const points = Array.from(t);
  return points.length > NAME_MAX ? points.slice(0, NAME_MAX).join("").trimEnd() + "..." : t;
}

type Titles = { custom?: string; ai?: string; agent?: string };
const TITLE_KINDS = ['"custom-title"', '"ai-title"', '"agent-name"'];

/** A title that is empty once whitespace is collapsed is ignored on purpose, so the next kind of name is used. */
function takeTitle(t: Titles, r: Record<string, any>): void {
  if (r.type === "custom-title" && typeof r.customTitle === "string" && tidy(r.customTitle)) t.custom = r.customTitle;
  else if (r.type === "ai-title" && typeof r.aiTitle === "string" && tidy(r.aiTitle)) t.ai = r.aiTitle;
  else if (r.type === "agent-name" && typeof r.agentName === "string" && tidy(r.agentName)) t.agent = r.agentName;
}

/** Read the head (to the first real prompt, at most 256 KB) and the tail (last 256 KB). Tail titles beat head titles of the same kind. */
async function readName(fs: TranscriptFs, file: string): Promise<NameInfo | undefined> {
  const head: Titles = {};
  const tail: Titles = {};
  let first: string | undefined;
  try {
    let bytes = 0;
    for await (const line of fs.lines(file)) {
      bytes += line.length + 1;
      const r = parse(line);
      if (r) {
        takeTitle(head, r);
        first = promptText(r);
      }
      if (first !== undefined || bytes > NAME_WINDOW) break;
    }
  } catch {
    // keep what was found
  }
  try {
    for (const line of (await fs.tail?.(file, NAME_WINDOW)) ?? []) {
      // Most tail lines are tool calls and results: skip them before the costly parse.
      if (!TITLE_KINDS.some((k) => line.includes(k))) continue;
      const r = parse(line);
      if (r) takeTitle(tail, r);
    }
  } catch {
    // keep what was found
  }
  const pick = (raw: string | undefined, source: NameSource): NameInfo | undefined => {
    const name = tidy(raw);
    return name ? { name, source } : undefined;
  };
  return (
    pick(tail.custom ?? head.custom, "custom") ?? pick(tail.ai ?? head.ai, "ai") ?? pick(tail.agent ?? head.agent, "agent") ?? pick(first, "prompt")
  );
}

/** The name of the transcript and where it came from. Cached by file size and modification time. */
export async function nameInfoOf(fs: TranscriptFs, f: Found, cache: NameCache): Promise<NameInfo | undefined> {
  const hit = cache.get(f.file);
  if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.name && hit.source ? { name: hit.name, source: hit.source } : undefined;
  const info = await readName(fs, f.file);
  cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, name: info?.name, source: info?.source });
  return info;
}

export async function nameOf(fs: TranscriptFs, f: Found, cache: NameCache): Promise<string | undefined> {
  return (await nameInfoOf(fs, f, cache))?.name;
}
