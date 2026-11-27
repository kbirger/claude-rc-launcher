import { existsSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { generateSecret } from "./auth/node";
import { loadConfigFile, resolveConfigPath } from "./config/file";
import { windowsDataDir } from "./config/parse";
import type { Config } from "./config/parse";
import { NodeEvents } from "./hosts/NodeEvents";
import { bunRunner } from "./instances/InstanceService";
import { startNode } from "./nodemain";
import { VERSION } from "./shared/version";
import { checkServiceAccount } from "./win/account";
import { definitionStatus } from "./win/definition";
import { planSessions, serviceAdminState } from "./win/token";
import { confirmPendingUpdate, createWindowsUpdater, realWinUpdateEnv, UPDATE_EXIT_CODE } from "./win/update";
import { taskkillTree, WinInstances } from "./win/WinInstances";
import { WinSshBridge } from "./win/WinSshBridge";

// The Windows node. Only this file imports ./win, so the Linux binaries never contain this code.

if (process.argv.includes("--version")) {
  console.log(`claude-rc-launcher ${VERSION}`);
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(0);
}

if (process.argv[2] === "gen-secret") {
  const { secret, sha256 } = generateSecret();
  console.log(`secret: ${secret}`);
  console.log(`sha256: ${sha256}`);
  console.log("# Hub: put the secret in a file and reference it as hosts[].auth.secret_file.");
  console.log("# Node: add the sha256 as a [[node_auth.secret]] entry. Never put the secret on the node.");
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(0);
}

let cfg: Config;

try {
  cfg = loadConfigFile(resolveConfigPath(process.argv, process.env, join(windowsDataDir(), "config.toml")), {
    windows: true,
  });
  checkServiceAccount(cfg.serviceUser, userInfo().username);
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(1);
}

console.log(`claude-rc-launcher ${VERSION} (Windows node), running as ${userInfo().username}`);

const { node: nodeConfig } = cfg;
if (!nodeConfig) throw new Error("the configuration has no node section");

const plan = planSessions(serviceAdminState());
console.log(plan.log);

const sshBridge = new WinSshBridge();

const instances = new WinInstances(
  {
    roots: cfg.roots,
    serviceUser: cfg.serviceUser,
    serviceHome: cfg.serviceHome,
    claudeBin: cfg.claudeBin,
    claudeRcArgs: cfg.claudeRcArgs,
    namePrefix: cfg.namePrefix,
    instanceDir: join(nodeConfig.tls.stateDir, "instances"),
    serviceIsAdmin: plan.serviceIsAdmin,
    sshEnv: (id) => {
      if (sshBridge.env) return sshBridge.env(id);
      console.error(
        `instance ${id} has SSH requests on, but the node has no SSH link: it starts without the variables`,
      );
      return {};
    },
    sshRefusal: () => sshBridge.refusal(),
  },
  { killTree: taskkillTree(bunRunner), ...(plan.spawnRestricted ? { spawnRestricted: plan.spawnRestricted } : {}) },
);

let running: { stop(): void } | undefined;
let closing = false;

const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  running?.stop();
  await instances.close();
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(code);
};

// After an update the agent ends itself with a non-zero code, so that WinSW starts the new binary (see win/update.ts).
const dataDir = nodeConfig.tls.stateDir;
const events = new NodeEvents();
const update = createWindowsUpdater(
  realWinUpdateEnv({
    dataDir,
    cfg,
    // Wait a moment so that the answer to the update request is sent first.
    scheduleExit: () => void setTimeout(() => void shutdown(UPDATE_EXIT_CODE), 2000),
  }),
  events.hooks(),
);

try {
  running = await startNode(cfg, {
    instances,
    update,
    events,
    winSshBridge: sshBridge,
    definition: () => definitionStatus({ exePath: process.execPath, readFile: (path) => readFileSync(path, "utf8") }),
  });
  const restored = await instances.restore();
  if (restored > 0) console.log(`started ${restored} instance${restored === 1 ? "" : "s"} from the saved list`);
  confirmPendingUpdate({
    dataDir,
    version: VERSION,
    exists: existsSync,
    readFile: (path) => readFileSync(path),
    remove: (path) => {
      rmSync(path, { force: true });
    },
    after: (ms, fn) => void setTimeout(fn, ms),
    log: (line) => {
      console.log(line);
    },
  });
} catch (caught) {
  console.error(`startup failed: ${(caught as Error).message}`);
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(1);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
