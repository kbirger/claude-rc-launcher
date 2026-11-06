import { createApp } from "./app";
import { createOidcClient } from "./auth";
import { ConfigError, loadConfig } from "./config";
import { bunRunner, InstanceService } from "./instances";
import { staticHandler } from "./static";
import { loadWebFiles } from "./webfiles";

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

const files = await loadWebFiles();
if (!files.has("/index.html")) console.warn("warning: web UI not built (no embedded files and no web/dist); API only");

const instances = new InstanceService(cfg, bunRunner);
const oidc = await createOidcClient(cfg);
// Forwarded headers are not consulted: the secure-cookie decision comes from PUBLIC_URL (https: => Secure).
const app = createApp({ cfg, instances, oidc, staticHandler: staticHandler(files) });

const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
console.log(`listening on ${cfg.host}:${server.port}`);
console.log(`public URL: ${cfg.publicUrl}`);

const shutdown = () => {
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
