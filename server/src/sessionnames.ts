/*
 * The name of a session, read from its transcript. This file only READS TRANSCRIPTS. See docs/session-files.md.
 * readName reads from the start up to the first real prompt (at most 256 KB, or 2 MB past a /compact summary), and the last 256 KB for title
 * records. Its result is cached by file size and modification time.
 */
import type { Found } from "./sessionscan";
import { parse } from "./transcript";
import type { TranscriptFs } from "./transcriptfs";

/**
 * Where a name came from. The order of trust is `live` and `custom` (someone set it, it is what the app shows), then
 * `ai`, then `agent`, then `prompt` (the first real prompt), then `default` (made by Claude Code, last resort).
 */
export type NameSource = "live" | "custom" | "ai" | "agent" | "prompt" | "default";
export const NAME_RANK: Record<NameSource, number> = { live: 4, custom: 4, ai: 3, agent: 2, prompt: 1, default: 0 };
export interface NameInfo {
  name: string;
  source: NameSource;
}

interface CacheValue {
  size: number | undefined;
  mtimeMs: number;
  name: string | undefined;
  source?: NameSource;
}
export interface NameCache {
  get(file: string): CacheValue | undefined;
  set(file: string, cacheValue: CacheValue): void;
}

/** A bounded map: when full, the oldest entry goes. */
export function newNameCache(max = 2000): NameCache {
  const map = new Map<string, CacheValue>();
  return {
    get: (file) => map.get(file),
    set(key, cacheValue) {
      map.delete(key);
      map.set(key, cacheValue);
      while (map.size > max) map.delete(map.keys().next().value!);
    },
  };
}

const NAME_WINDOW = 256 * 1024;
/** After /compact the transcript starts with the summary, and the first prompt can come far below it (the work of the old session is not kept, but the tool output that follows can be large). The read goes on this many bytes past the summary. */
const COMPACT_WINDOW = 2 * 1024 * 1024;
const NAME_MAX = 80;

const NOT_PROMPT = [
  "<command-name>",
  "<local-command",
  "<system-reminder",
  "<command-message",
  "Caveat:",
  "[Request interrupted",
];

/** The summary that /compact puts at the start of a transcript. */
function isCompactSummary(record: Record<string, any>): boolean {
  return record.isCompactSummary === true;
}

/** A "user" record that Claude Code wrote, not the user: a meta record or a compact summary. */
function writtenByClaudeCode(record: Record<string, any>): boolean {
  return record.isMeta === true || isCompactSummary(record);
}

/** The text of a real user prompt, or undefined for records Claude Code wrote, command echoes and system messages. */
function promptText(record: Record<string, any>): string | undefined {
  if (record.type !== "user" || writtenByClaudeCode(record)) return undefined;
  const content = record.message?.content;
  let text: unknown = content;
  if (Array.isArray(content))
    text = content.find((block) => block && block.type === "text" && typeof block.text === "string")?.text;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0 || NOT_PROMPT.some((item) => trimmed.startsWith(item))) return undefined;
  return trimmed;
}

export function tidy(raw: string | undefined): string | undefined {
  // Drop format and control characters (bidi overrides, zero-width characters) and collapse whitespace, so that a
  // name cannot look like another one. A joined emoji (it uses U+200D) is shown as its parts.
  // Format characters go first, because \s also matches U+FEFF. Control characters go after the collapse, so that a
  // tab or a line feed still becomes a space.
  const trimmed = (raw ?? "")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (trimmed.length === 0) return undefined;
  // Cut on code points, not UTF-16 units, so that an emoji is never split in half.
  const points = Array.from(trimmed);
  return points.length > NAME_MAX ? points.slice(0, NAME_MAX).join("").trimEnd() + "..." : trimmed;
}

interface Titles {
  custom?: string;
  ai?: string;
  agent?: string;
}
const TITLE_KINDS = ['"custom-title"', '"ai-title"', '"agent-name"'];

/** A title that is empty once whitespace is collapsed is ignored on purpose, so the next kind of name is used. */
function takeTitle(titles: Titles, record: Record<string, any>): void {
  if (record.type === "custom-title" && typeof record.customTitle === "string" && tidy(record.customTitle))
    titles.custom = record.customTitle;
  else if (record.type === "ai-title" && typeof record.aiTitle === "string" && tidy(record.aiTitle))
    titles.ai = record.aiTitle;
  else if (record.type === "agent-name" && typeof record.agentName === "string" && tidy(record.agentName))
    titles.agent = record.agentName;
}

/** Read the head (to the first real prompt, at most 256 KB) and the tail (last 256 KB). Tail titles beat head titles of the same kind. */
async function readName(fs: TranscriptFs, file: string): Promise<NameInfo | undefined> {
  const head: Titles = {};
  const tail: Titles = {};
  let first: string | undefined;

  try {
    let bytes = 0;
    let limit = NAME_WINDOW;

    for await (const line of fs.lines(file)) {
      bytes += line.length + 1;
      const record = parse(line);

      if (record) {
        takeTitle(head, record);
        if (isCompactSummary(record)) limit = Math.max(limit, bytes + COMPACT_WINDOW);
        first = promptText(record);
      }

      if (first !== undefined || bytes > limit) break;
    }
  } catch {
    // keep what was found
  }

  try {
    for (const line of (await fs.tail?.(file, NAME_WINDOW)) ?? []) {
      // Most tail lines are tool calls and results: skip them before the costly parse.
      if (!TITLE_KINDS.some((item) => line.includes(item))) continue;
      const record = parse(line);
      if (record) takeTitle(tail, record);
    }
  } catch {
    // keep what was found
  }

  const pick = (raw: string | undefined, source: NameSource): NameInfo | undefined => {
    const name = tidy(raw);
    return name ? { name, source } : undefined;
  };

  return (
    pick(tail.custom ?? head.custom, "custom") ??
    pick(tail.ai ?? head.ai, "ai") ??
    pick(tail.agent ?? head.agent, "agent") ??
    pick(first, "prompt")
  );
}

/** The name of the transcript and where it came from. Cached by file size and modification time. */
export async function nameInfoOf(fs: TranscriptFs, found: Found, cache: NameCache): Promise<NameInfo | undefined> {
  const hit = cache.get(found.file);
  if (hit && hit.size === found.size && hit.mtimeMs === found.mtimeMs)
    return hit.name && hit.source ? { name: hit.name, source: hit.source } : undefined;
  const info = await readName(fs, found.file);
  cache.set(found.file, { size: found.size, mtimeMs: found.mtimeMs, name: info?.name, source: info?.source });
  return info;
}

/** The names that one session can have, from the places that know them. Each one is already tidy. */
export interface NameParts {
  /** The name in the running-session file. */
  live?: string;
  /** True when Claude Code made `live` up (see `nameIsDefault` in livesessions.ts). */
  liveIsDefault?: boolean;
  /** The name of the first transcript of the chain, when `/clear` joined several. The app names the whole connection from it. */
  chain?: string;
  /** The name from this transcript: a title, or the first real prompt (see readName). */
  transcript?: string;
}

/**
 * The name of a session. This is the only place that orders the sources:
 * 1. A live name that someone set. The Claude app shows it, and it changes while the session runs.
 * 2. The name of the first transcript of the chain.
 * 3. The name of this transcript.
 * 4. A live name that Claude Code made up. It comes last: the titles in the transcript say more.
 */
export function chooseName(nameParts: NameParts): string | undefined {
  const set = nameParts.liveIsDefault ? undefined : nameParts.live;
  return set ?? nameParts.chain ?? nameParts.transcript ?? nameParts.live;
}

export async function nameOf(fs: TranscriptFs, found: Found, cache: NameCache): Promise<string | undefined> {
  return (await nameInfoOf(fs, found, cache))?.name;
}
