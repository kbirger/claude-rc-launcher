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

for (const name of readdirSync(dir)
  .filter((item) => item.endsWith(".jsonl"))
  .sort()) {
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
    let item: any;

    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    if (item.sessionId && !sessionId) sessionId = item.sessionId;
    if (item.gitBranch) branch = item.gitBranch;

    if (item.cwd) {
      if (!firstCwd) firstCwd = item.cwd;
      lastCwd = item.cwd;
    }

    if (item.entrypoint && !entrypoint) entrypoint = item.entrypoint;
    if (item.type === "bridge-session") bridge = true;
    const content = item.message?.content;

    if (item.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const field = WRITE_TOOLS[block.name];

        if (field) {
          toolNames.add(block.name);
          const value = block.input?.[field];
          if (typeof value === "string") paths.add(value);
        }
      }
    }
  }

  console.log(`\n${name}`);
  console.log(`  sessionId=${sessionId} branch=${branch} entrypoint=${entrypoint} bridge=${bridge}`);
  console.log(`  firstCwd=${firstCwd} lastCwd=${lastCwd}`);
  console.log(`  tools=${[...toolNames].join(",")} paths=${paths.size}`);
  for (const item of [...paths].slice(0, 5)) console.log(`    ${item}`);
}
