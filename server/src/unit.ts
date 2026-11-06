import { createHash } from "node:crypto";
import type { Config } from "./config";

const MARKER = "# managed-by: claude-rc-launcher path=";
const NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/; // no leading "-": it would be parsed as a CLI flag
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029]");

export function instanceId(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

export function unitName(id: string): string {
  return `claude-rc-${id}.service`;
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function defaultName(cfg: Config, absPath: string): string {
  const base = absPath.split("/").filter(Boolean).pop() ?? "";
  const raw = (cfg.namePrefix + base).replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+/, "").slice(0, 64);
  return raw || "claude";
}

function safe(label: string, v: string): string {
  if (CONTROL_RE.test(v)) throw new Error(`${label} contains control characters`);
  return v;
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

export function renderUnit(cfg: Config, absPath: string, name: string): string {
  if (!isValidName(name)) throw new Error("invalid instance name");
  safe("path", absPath);
  if (!absPath.startsWith("/")) throw new Error("path must be absolute");
  if (absPath.includes("\\")) throw new Error("path must not contain backslashes");
  if (absPath !== absPath.trim()) throw new Error("path must not have leading or trailing whitespace");
  const userScope = cfg.scope === "user";
  const user = safe("User", cfg.serviceUser);
  if (/\s/.test(user) || user.includes("\\")) throw new Error("invalid service user");

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
    envLine("HOME", cfg.serviceHome),
    envLine("PATH", cfg.servicePath),
  ];
  if (cfg.sshAuthSock) lines.push(envLine("SSH_AUTH_SOCK", cfg.sshAuthSock));
  const exec = [cfg.claudeBin, "remote-control", "--name", name, ...cfg.claudeRcArgs].map(execWord).join(" ");
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
