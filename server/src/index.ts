import { ConfigError } from "./config";
import type { Config } from "./config";
import { applyLocal, loadConfigFile, resolveConfigPath } from "./configfile";
import { startHub } from "./hubmain";
import { generateSecret } from "./nodeauth";
import { startNode } from "./nodemain";
import { runNudgeSend } from "./nudge";
import { VERSION } from "./shared/version";

if (process.argv.includes("--version")) {
  console.log(`claude-rc-launcher ${VERSION}`);
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(0);
}

if (process.argv[2] === "nudge-send") {
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(await runNudgeSend(process.argv.slice(2), () => Bun.stdin.text()));
}

if (process.argv[2] === "gen-secret") {
  const { secret, sha256 } = generateSecret();
  console.log(`secret: ${secret}`);
  console.log(`sha256: ${sha256}`);
  console.log("# Hub: put the secret in a mode-600 file and reference it as hosts[].auth.secret_file.");
  console.log("# Node: add the sha256 as a [[node_auth.secret]] entry. Never put the secret on the node.");
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(0);
}

let cfg: Config;

try {
  cfg = applyLocal(loadConfigFile(resolveConfigPath(process.argv, process.env)), process.argv);
} catch (caught) {
  if (caught instanceof ConfigError) {
    console.error(caught.message);
    // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
    process.exit(1);
  }

  throw caught;
}

let running: { stop(): void };

try {
  running = cfg.mode === "node" ? await startNode(cfg) : await startHub(cfg);
} catch (caught) {
  console.error(`startup failed: ${(caught as Error).message}`);
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(1);
}

const shutdown = () => {
  running.stop();
  // Leave a moment for the open streams to end cleanly.
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  setTimeout(() => process.exit(0), 300);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
