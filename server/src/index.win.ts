import { userInfo } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { windowsDataDir, type Config } from "./config";
import { loadConfigFile, resolveConfigPath } from "./configfile";
import { bunRunner } from "./instances";
import { generateSecret } from "./nodeauth";
import { startNode } from "./nodemain";
import { VERSION } from "./version";
import { checkServiceAccount } from "./win/account";
import { taskkillTree, WinInstances } from "./win/instances";
import { restrictedSpawn, serviceIsAdmin } from "./win/token";
import { confirmPendingUpdate, createWindowsUpdater, realWinUpdateEnv, UPDATE_EXIT_CODE } from "./win/update";

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

console.log(`claude-rc-launcher ${VERSION} (Windows node), running as ${userInfo().username}`);

const admin = serviceIsAdmin();
console.log(admin ? "sessions run restricted by default (service account is an administrator)" : "sessions run as the service account (no administrator rights to drop)");

const instances = new WinInstances(
  {
    roots: cfg.roots,
    serviceUser: cfg.serviceUser,
    serviceHome: cfg.serviceHome,
    claudeBin: cfg.claudeBin,
    claudeRcArgs: cfg.claudeRcArgs,
    namePrefix: cfg.namePrefix,
    instanceDir: join(cfg.node!.tls.stateDir, "instances"),
    serviceIsAdmin: admin,
  },
  { killTree: taskkillTree(bunRunner), ...(admin ? { spawnRestricted: restrictedSpawn() } : {}) },
);

let running: { stop(): void };
let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  running?.stop();
  await instances.close();
  process.exit(code);
};

// After an update the agent ends itself with a non-zero code, so that WinSW starts the new binary (see win/update.ts).
const dataDir = cfg.node!.tls.stateDir;
const update = createWindowsUpdater(
  realWinUpdateEnv({
    dataDir,
    // Wait a moment so that the answer to the update request is sent first.
    scheduleExit: () => void setTimeout(() => void shutdown(UPDATE_EXIT_CODE), 2000),
  }),
);

try {
  running = await startNode(cfg, { instances, update });
  const n = await instances.restore();
  if (n > 0) console.log(`started ${n} instance${n === 1 ? "" : "s"} from the saved list`);
  confirmPendingUpdate({
    dataDir,
    version: VERSION,
    exists: existsSync,
    readFile: (p) => readFileSync(p),
    remove: (p) => rmSync(p, { force: true }),
    after: (ms, fn) => void setTimeout(fn, ms),
    log: (line) => console.log(line),
  });
} catch (e) {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
