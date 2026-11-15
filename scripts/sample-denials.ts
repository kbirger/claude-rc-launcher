/*
 * Prints the most common first lines of failed tool results in the Claude Code transcripts of this machine.
 * Use it to build or check the denial text catalog in server/src/blocked.ts.
 *
 *   bun scripts/sample-denials.ts [projects folder] [how many]
 *
 * Each text is cut to 110 characters and shown with its count. Paths and commands in the text can be private:
 * read the output, never paste it into a fixture as it is.
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = process.argv[2] ?? join(homedir(), ".claude", "projects");
const top = Number(process.argv[3] ?? 40);
const counts = new Map<string, number>();

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && typeof (c as any).text === "string" ? (c as any).text : "")).join("");
  return "";
}

for (const dir of await readdir(root).catch(() => [])) {
  for (const f of await readdir(join(root, dir)).catch(() => [])) {
    if (!f.endsWith(".jsonl")) continue;
    const rl = createInterface({ input: createReadStream(join(root, dir, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"is_error":true')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type !== "tool_result" || b.is_error !== true) continue;
        const first = textOf(b.content).split("\n")[0]!.trim().slice(0, 110);
        counts.set(first, (counts.get(first) ?? 0) + 1);
      }
    }
  }
}
for (const [text, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(String(n).padStart(6), text);
