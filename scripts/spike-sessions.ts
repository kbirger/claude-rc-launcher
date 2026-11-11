// Spike: find and parse Claude Code session transcripts for an instance folder.
// Usage: bun scripts/spike-sessions.ts <instance-folder> <home-folder>
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [instance, home] = process.argv.slice(2);
if (!instance || !home) {
  console.error("usage: bun scripts/spike-sessions.ts <instance-folder> <home-folder>");
  process.exit(2);
}

const folderName = instance.replace(/[^a-zA-Z0-9]/g, "-");
const dir = join(home, ".claude", "projects", folderName);
console.log(`folder name: ${folderName}`);
console.log(`transcript dir: ${dir} exists=${existsSync(dir)}`);
if (!existsSync(dir)) process.exit(0);

// Tools that take a file path, and the field that holds it.
const WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
  let sessionId = "";
  let branch = "";
  let firstCwd = "";
  let lastCwd = "";
  let entrypoint = "";
  let bridge = false;
  const paths = new Set<string>();
  const toolNames = new Set<string>();
  for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.cwd) { if (!firstCwd) firstCwd = r.cwd; lastCwd = r.cwd; }
    if (r.entrypoint && !entrypoint) entrypoint = r.entrypoint;
    if (r.type === "bridge-session") bridge = true;
    const content = r.message?.content;
    if (r.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        const field = WRITE_TOOLS[b.name];
        if (field) {
          toolNames.add(b.name);
          const p = b.input?.[field];
          if (typeof p === "string") paths.add(p);
        }
      }
    }
  }
  console.log(`\n${name}`);
  console.log(`  sessionId=${sessionId} branch=${branch} entrypoint=${entrypoint} bridge=${bridge}`);
  console.log(`  firstCwd=${firstCwd} lastCwd=${lastCwd}`);
  console.log(`  tools=${[...toolNames].join(",")} paths=${paths.size}`);
  for (const p of [...paths].slice(0, 5)) console.log(`    ${p}`);
}
