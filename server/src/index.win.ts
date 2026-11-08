import { userInfo } from "node:os";
import { join } from "node:path";
import { UpdateRefused } from "./serviceupdate";
import type { Updater } from "./app";
import { windowsDataDir, type Config } from "./config";
import { loadConfigFile, resolveConfigPath } from "./configfile";
import { bunRunner } from "./instances";
import { generateSecret } from "./nodeauth";
import { startNode } from "./nodemain";
import { VERSION } from "./version";
import { checkServiceAccount } from "./win/account";
import { taskkillTree, WinInstances } from "./win/instances";

// The Windows node. Only this file imports ./win, so the Linux binaries never contain this code.

if (process.argv.includes("--version")) {
  console.log(`claude-rc-launcher ${VERSION}`);
  process.exit(0);
}

if (process.argv[2] === "gen-secret") {
  const { secret, sha256 } = generateSecret();
  console.log(`secret: ${secret}`);
  console.log(`sha256: ${sha256}`);
  console.log("# Hub: put the secret in a file and reference it as hosts[].auth.secret_file.");
  console.log("# Node: add the sha256 as a [[node_auth.secret]] entry. Never put the secret on the node.");
  process.exit(0);
}

let cfg: Config;
try {
  cfg = loadConfigFile(resolveConfigPath(process.argv, process.env, join(windowsDataDir(), "config.toml")), { windows: true });
  checkServiceAccount(cfg.serviceUser, userInfo().username);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const instances = new WinInstances(
  {
    roots: cfg.roots,
    serviceUser: cfg.serviceUser,
    serviceHome: cfg.serviceHome,
    claudeBin: cfg.claudeBin,
    claudeRcArgs: cfg.claudeRcArgs,
    namePrefix: cfg.namePrefix,
    instanceDir: join(cfg.node!.tls.stateDir, "instances"),
  },
  { killTree: taskkillTree(bunRunner) },
);

// Self-update on Windows is not written yet: refuse it clearly, as the Linux updater does on other platforms.
const update: Updater = {
  async run() {
    throw new UpdateRefused(409, "the update is not available on Windows yet");
  },
};

let running: { stop(): void };
try {
  running = await startNode(cfg, { instances, update });
  const n = await instances.restore();
  if (n > 0) console.log(`started ${n} instance${n === 1 ? "" : "s"} from the saved list`);
} catch (e) {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  running.stop();
  await instances.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
