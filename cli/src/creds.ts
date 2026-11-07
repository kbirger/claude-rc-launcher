import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Credentials = {
  hub: string;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  idToken: string;
  refreshToken?: string;
  /** Epoch seconds at which the ID token expires. */
  expiresAt: number;
};

/** An error that ends the program: code 1 is a failure, code 2 means that the user must log in again. */
export class ExitError extends Error {
  constructor(
    message: string,
    public code: 1 | 2,
  ) {
    super(message);
    this.name = "ExitError";
  }
}

export const LOGIN_MESSAGE = 'not signed in or the login expired: run "claude-rc login"';

/**
 * Where the credential file lives. The only environment variables the CLI reads are the ones that name the user's
 * standard configuration directory. The hub URL and tokens never come from the environment.
 */
export function credsPath(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  if (platform === "win32") return path.win32.join(env.APPDATA ?? path.win32.join(home, "AppData", "Roaming"), "claude-rc", "credentials.json");
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), "claude-rc", "credentials.json");
}

export function loadCreds(file: string): Credentials | undefined {
  if (!existsSync(file)) return undefined;
  if (process.platform !== "win32" && statSync(file).mode & 0o077) {
    throw new ExitError(`${file} must not be accessible by group or others (chmod 600 ${file})`, 1);
  }
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    for (const k of ["hub", "issuer", "clientId", "tokenEndpoint", "idToken"]) if (typeof c[k] !== "string" || !c[k]) throw new Error(k);
    if (typeof c.expiresAt !== "number") throw new Error("expiresAt");
    return c as Credentials;
  } catch {
    throw new ExitError(`${file} is not valid. Delete it and run "claude-rc login"`, 1);
  }
}

export function saveCreds(file: string, c: Credentials): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function deleteCreds(file: string): void {
  rmSync(file, { force: true });
}
