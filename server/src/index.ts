import { ConfigError, type Config } from "./config";
import { loadConfigFile, resolveConfigPath } from "./configfile";
import { startHub } from "./hubmain";
import { generateSecret } from "./nodeauth";
import { startNode } from "./nodemain";

if (process.argv[2] === "gen-secret") {
  const { secret, sha256 } = generateSecret();
  console.log(`secret: ${secret}`);
  console.log(`sha256: ${sha256}`);
  console.log("# Hub: put the secret in a mode-600 file and reference it as hosts[].auth.secret_file.");
  console.log("# Node: add the sha256 as a [[node_auth.secret]] entry. Never put the secret on the node.");
  process.exit(0);
}

let cfg: Config;
try {
  cfg = loadConfigFile(resolveConfigPath(process.argv, process.env));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

let running: { stop(): void };
try {
  running = cfg.mode === "node" ? await startNode(cfg) : await startHub(cfg);
} catch (e) {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
}

const shutdown = () => {
  running.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
