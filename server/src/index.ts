import type { Config } from "./config";
import { createApp } from "./app";
import { createOidcClient } from "./auth";
import { ConfigError } from "./config";
import { loadConfigFile, resolveConfigPath } from "./configfile";
import { bunRunner, InstanceService } from "./instances";
import { staticHandler } from "./static";
import { loadWebFiles } from "./webfiles";

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

const files = await loadWebFiles();
if (!files.has("/index.html")) console.warn("warning: web UI not built (no embedded files and no web/dist); API only");

if (cfg.userAuth.oidc.issuer.startsWith("http:")) {
  console.warn(
    "warning: user_auth.oidc.issuer uses plain http; ID tokens are not signature-verified, so a network attacker could forge logins. Use https in production.",
  );
}

// Folders created via the UI must be owned by SERVICE_USER when we run as root for another user.
async function resolveDirOwner(): Promise<{ uid: number; gid: number } | undefined> {
  if (process.getuid?.() !== 0 || cfg.serviceUser === "root") return undefined;
  const num = async (flag: "-u" | "-g") => {
    const r = await bunRunner("id", [flag, cfg.serviceUser]);
    const n = Number(r.stdout.trim());
    if (r.code !== 0 || !Number.isInteger(n) || n < 0) {
      console.error(`cannot resolve SERVICE_USER "${cfg.serviceUser}" (id ${flag}): ${r.stderr.trim() || r.stdout.trim()}`);
      process.exit(1);
    }
    return n;
  };
  return { uid: await num("-u"), gid: await num("-g") };
}
const dirOwner = await resolveDirOwner();

const instances = new InstanceService(cfg, bunRunner);
const oidc = await createOidcClient(cfg);
// Forwarded headers are not consulted: the secure-cookie decision comes from PUBLIC_URL (https: => Secure).
const app = createApp({ cfg, instances, oidc, staticHandler: staticHandler(files), dirOwner });

const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
console.log(`listening on ${cfg.host}:${server.port}`);
console.log(`public URL: ${cfg.publicUrl}`);

const shutdown = () => {
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
