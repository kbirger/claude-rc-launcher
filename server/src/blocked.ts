/*
 * The tool calls that Claude Code blocked in one known transcript, found by pairing each call with its result.
 * This file only READS TRANSCRIPTS, as touched.ts does. See docs/superpowers/specs/2026-11-14-permissions-design.md.
 *
 * A blocked call is a `tool_use` block (in an `assistant` record) with a later `tool_result` block (in a `user` record)
 * that has `is_error: true` and a known denial text. A command that failed by itself (exit code 1) also has `is_error: true`,
 * so the text decides. The texts are Claude Code internals and can change with a version: DENIALS is the one table to
 * update. A denial with a text
 * that is not in the table is not listed (a lower bound, like the touched list).
 */
import { dig, isRecord, parse } from "./transcript";
import type { TranscriptFs } from "./transcriptfs";

/**
 * needs_approval: the call needed a prompt and nobody could answer (a rule fixes it).
 * user_rejected: the user said no.
 * classifier: the auto mode classifier denied it, or gave no verdict.
 * deny_rule: a deny rule matched (no allow rule helps).
 * safety_check: a built-in guard stopped it.
 */
export type BlockReason = "needs_approval" | "user_rejected" | "classifier" | "deny_rule" | "safety_check";

export interface BlockedCall {
  id: string;
  at: string;
  tool: string;
  input: Record<string, unknown>;
  reason: BlockReason;
  text: string;
}

/** The first match wins, so the specific texts come first. */
const DENIALS: readonly [RegExp, BlockReason][] = [
  [/denied by a built-in Claude Code safety check/, "safety_check"],
  [/auto mode classifier/, "classifier"],
  [/has been denied by your rule|is blocked by an? (?:\w+ )?permission rule|denied by an? deny rule/, "deny_rule"],
  [/doesn't want to proceed with this tool use|The tool use was rejected/, "user_rejected"],
  [/has been denied because Claude Code is running in don't ask mode|needs approval/, "needs_approval"],
];

/** The reason for a tool result text, or undefined when the text is not a denial. */
export function classifyDenial(text: string): BlockReason | undefined {
  for (const [re, reason] of DENIALS) if (re.test(text)) return reason;
  return undefined;
}

const PENDING_MAX = 1000;
const ANSWERED_MAX = 10000;
const DEFAULT_MAX = 200;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: unknown[] = content;
  return parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

function putNewest<Key, Value>(map: Map<Key, Value>, key: Key, value: Value, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as Key);
}

interface Use {
  at: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * The blocked calls of one transcript, newest first, at most `max` (default 200).
 * It reads the whole transcript line by line and parses only the lines that contain "tool_use" or "tool_result".
 * Fail closed: a result before its use, a result for an id that was seen with two different tool names, a repeat of a
 * use after its result, and a use dropped from the full pending list (1000, oldest first) never give an entry.
 * A repeat of the same tool_use id with the same tool name is the same call (Claude Code can write several records for
 * one response while it streams): the first is kept.
 */
export async function blockedIn(options: { fs: TranscriptFs; file: string; max?: number }): Promise<BlockedCall[]> {
  const max = options.max ?? DEFAULT_MAX;
  const pending = new Map<string, Use | null>();
  const answered = new Map<string, true>();
  const found: BlockedCall[] = [];

  try {
    for await (const line of options.fs.lines(options.file)) {
      if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
      const record = parse(line);
      const content: unknown = dig(record, "message", "content");
      if (!Array.isArray(content)) continue;
      const blocks: unknown[] = content;

      if (record?.type === "user") {
        for (const block of blocks) {
          if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const id = block.tool_use_id;
          if (!pending.has(id)) continue;
          const response = pending.get(id);
          pending.delete(id);
          putNewest(answered, id, true, ANSWERED_MAX);
          if (!response || block.is_error !== true) continue;
          const text = textOf(block.content);
          const reason = classifyDenial(text);
          if (!reason) continue;
          found.push({ id, at: response.at, tool: response.tool, input: response.input, reason, text });
          if (found.length > max) found.shift();
        }

        continue;
      }

      if (record?.type !== "assistant") continue;

      for (const block of blocks) {
        if (
          !isRecord(block) ||
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string"
        )
          continue;
        const id = block.id;
        if (answered.has(id)) continue;
        const input = isRecord(block.input) ? block.input : {};
        const use: Use = { at: typeof record.timestamp === "string" ? record.timestamp : "", tool: block.name, input };

        if (pending.has(id)) {
          const prior = pending.get(id);
          // The same call again: keep the first. Another tool name for the same id: nothing may confirm it.
          if (prior && prior.tool !== use.tool) pending.set(id, null);
          continue;
        }

        putNewest(pending, id, use, PENDING_MAX);
      }
    }
  } catch {
    // The transcript vanished or could not be read further: keep what was found.
  }

  return found.reverse();
}
