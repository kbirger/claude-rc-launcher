import { createHash } from "node:crypto";
import type { Config } from "../config/parse";
import { argsWith, settingsFromArgs } from "./settings";
import type { InstanceSettings } from "./settings";
import { USER_NAME_RE } from "../shared/users";
import type { SystemUser } from "../shared/users";

const MARKER = "# managed-by: claude-rc-launcher path=";
const NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/; // no leading "-": it would be parsed as a CLI flag

/** The top folder of the node for SSH sockets and grant files. Each instance has a folder of its own in it. */
export const SSH_RUN_DIR = "/run/claude-rc-ssh";
const SSH_CONTROL_KEY = "CLAUDE_RC_SSH_CONTROL";

const CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;

export function instanceId(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

export function unitName(id: string): string {
  return `claude-rc-${id}.service`;
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function defaultName(cfg: Pick<Config, "namePrefix">, absPath: string): string {
  // A drive-letter or UNC path uses "\" as well as "/"; a POSIX path only "/".
  const windowsStyle = /^([A-Za-z]:|\\\\)/.test(absPath);
  const rest = windowsStyle ? absPath.replace(/^[A-Za-z]:/, "") : absPath;
  const base =
    rest
      .split(windowsStyle ? /[\\/]/ : "/")
      .filter(Boolean)
      .pop() ?? "";
  const raw = (cfg.namePrefix + base)
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
  return raw || "claude";
}

function safe(label: string, text: string): string {
  if (CONTROL_RE.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

/** Escape for unquoted-or-quoted ExecStart words: %, $, \ and ". */
function execWord(arg: string): string {
  safe("ExecStart argument", arg);
  const esc = arg.replace(/%/g, "%%").replace(/\$/g, "$$$$").replace(/[\\]/g, "\\\\").replace(/"/g, '\\"');
  return /^[A-Za-z0-9_@:,./=+-]+$/.test(arg) ? esc : `"${esc}"`;
}

function envLine(key: string, value: string): string {
  safe(`Environment ${key}`, value);
  const esc = value.replace(/%/g, "%%").replace(/[\\]/g, "\\\\").replace(/"/g, '\\"');
  return `Environment="${key}=${esc}"`;
}

export interface RunAs {
  user: string;
  home: string;
  path: string;
  claudeBin: string;
}

export function defaultRunAs(cfg: Config): RunAs {
  return { user: cfg.serviceUser, home: cfg.serviceHome, path: cfg.servicePath, claudeBin: cfg.claudeBin };
}

export function runAsFor(_cfg: Config, systemUser: SystemUser): RunAs {
  if (!USER_NAME_RE.test(systemUser.name)) throw new Error("invalid service user");
  return {
    user: systemUser.name,
    home: systemUser.home,
    path: `${systemUser.home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    claudeBin: `${systemUser.home}/.local/bin/claude`,
  };
}

export function parseUnitUser(content: string): string | null {
  const match = /^User=(.+)$/m.exec(content);
  return match ? match[1] : null;
}

export function renderUnit(
  cfg: Config,
  absPath: string,
  name: string,
  runAs: RunAs = defaultRunAs(cfg),
  settings?: InstanceSettings,
): string {
  if (!isValidName(name)) throw new Error("invalid instance name");
  safe("path", absPath);
  if (!absPath.startsWith("/")) throw new Error("path must be absolute");
  if (absPath.includes("\\")) throw new Error("path must not contain backslashes");
  if (absPath !== absPath.trim()) throw new Error("path must not have leading or trailing whitespace");
  const userScope = cfg.scope === "user";
  const user = safe("User", runAs.user);
  if (/\s/.test(user) || user.includes("\\") || user.includes("=")) throw new Error("invalid service user");

  const lines = [
    `${MARKER}${absPath}`,
    "[Unit]",
    "Description=Claude Code Remote Control Server",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    ...(userScope ? [] : [`User=${user}`]),
    `WorkingDirectory=${absPath.replace(/%/g, "%%")}`,
    envLine("HOME", runAs.home),
    envLine("PATH", runAs.path),
  ];
  if (cfg.sshAuthSock) lines.push(envLine("SSH_AUTH_SOCK", cfg.sshAuthSock));
  if (settings?.sshRequests) lines.push(envLine(SSH_CONTROL_KEY, `${SSH_RUN_DIR}/${instanceId(absPath)}/control.sock`));
  const exec = [
    runAs.claudeBin,
    "remote-control",
    "--name",
    name,
    ...(settings ? argsWith(cfg.claudeRcArgs, settings) : cfg.claudeRcArgs),
  ]
    .map(execWord)
    .join(" ");
  lines.push(
    `ExecStart=${exec}`,
    "StandardOutput=null",
    "StandardError=journal",
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    userScope ? "WantedBy=default.target" : "WantedBy=multi-user.target",
    "",
  );
  return lines.join("\n");
}

export function parseManaged(fileContent: string): { path: string } | null {
  const first = fileContent.split("\n", 1)[0] ?? "";
  if (!first.startsWith(MARKER)) return null;
  const path = first.slice(MARKER.length);
  return path ? { path } : null;
}

/** Split an ExecStart value into words. It undoes execWord: quotes, backslash escapes, %% and $$. */
export function execWords(value: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (char === "\\" && index + 1 < value.length) {
      cur += value[++index];
      has = true;
    } else if (char === '"') {
      quoted = !quoted;
      has = true;
    } else if ((char === "%" || char === "$") && value[index + 1] === char) {
      cur += char;
      index++;
      has = true;
    } else if (!quoted && /\s/.test(char)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += char;
      has = true;
    }
  }

  if (has) words.push(cur);
  return words;
}

/** Read the instance settings from the ExecStart line. The flags come after "--name <value>". */
export function parseUnitSettings(content: string): InstanceSettings {
  const match = /^ExecStart=(.*)$/m.exec(content);
  const words = match ? execWords(match[1]) : [];
  const position = words.indexOf("--name");
  const fromArgs = settingsFromArgs(position >= 0 ? words.slice(position + 2) : []);
  // A unit from before the setting has no such line and reads as off.
  return { ...fromArgs, sshRequests: new RegExp(`^Environment="${SSH_CONTROL_KEY}=`, "m").test(content) };
}
