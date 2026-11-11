import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigError, parseConfig, type Config, type ConfigIo, type ParseOptions } from "./config";

export const DEFAULT_CONFIG_PATH = "/etc/claude-rc-launcher/config.toml";

export function resolveConfigPath(argv: string[], env: Record<string, string | undefined>, defaultPath = DEFAULT_CONFIG_PATH): string {
  const i = argv.indexOf("--config");
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  const eq = argv.find((a) => a.startsWith("--config="));
  if (eq) return eq.slice("--config=".length);
  return env.CLAUDE_RC_CONFIG || defaultPath;
}

/** `--local`: for running from a checkout. The hub's public URL becomes http://localhost:<port>, whatever `public_url` says. */
export function applyLocal(cfg: Config, argv: string[]): Config {
  if (!argv.includes("--local")) return cfg;
  if (cfg.mode !== "hub") throw new ConfigError(["--local applies to a hub only: a node has no public_url"]);
  return { ...cfg, publicUrl: `http://localhost:${cfg.port}` };
}

export function makeIo(dir: string): ConfigIo {
  return {
    readFile(file, kind) {
      const full = path.resolve(dir, file);
      let text: string;
      try {
        if (kind === "secret" && process.platform !== "win32") {
          const mode = statSync(full).mode;
          if (mode & 0o077) throw new Error(`${full} must not be accessible by group or others (chmod 600)`);
        }
        text = readFileSync(full, "utf8");
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        throw new Error(err.code === "ENOENT" ? `cannot read ${full}: file not found` : err.message);
      }
      return text.replace(/\r?\n$/, "");
    },
  };
}

export function loadConfigFile(file: string, opts: ParseOptions = {}): Config {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError([`cannot read config file ${file}: ${(e as Error).message}`]);
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError([`${file} is not valid TOML: ${(e as Error).message}`]);
  }
  return parseConfig(raw, makeIo(path.dirname(path.resolve(file))), opts);
}
