import { existsSync } from "node:fs";

export interface Identity {
  home: string;
  path: string;
  uid?: number;
  gid?: number;
}
export type IdentityFor = (user?: string) => Promise<Identity>;

/**
 * Where setpriv may live. The node runs setpriv as root, so the program must never come from a PATH search: the
 * PATH of the instance user holds folders of that user, which could hold a program with this name.
 */
const SETPRIV_PATHS = ["/usr/bin/setpriv", "/bin/setpriv", "/usr/sbin/setpriv", "/sbin/setpriv"];

/** The first fixed path that exists, or undefined. `exists` is for tests. */
export function findSetpriv(exists: (path: string) => boolean = existsSync): string | undefined {
  return SETPRIV_PATHS.find((path) => exists(path));
}

/** Wraps a command so it runs as the identity's user. The env REPLACES the child's whole environment. */
export function asUser(
  id: Identity,
  cmd: string,
  args: string[],
  findProgram: () => string | undefined = findSetpriv,
): { cmd: string; args: string[]; env: Record<string, string> } {
  const env = {
    HOME: id.home,
    PATH: id.path,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    LANG: "C.UTF-8",
  };
  if (id.uid === undefined || id.gid === undefined) return { cmd, args, env };
  // The command that runs before the switch of user is an absolute path. The command after `--` runs as the user.
  const setpriv = findProgram();
  if (setpriv === undefined) throw new Error("setpriv is not installed");

  return {
    cmd: setpriv,
    args: ["--reuid", String(id.uid), "--regid", String(id.gid), "--init-groups", "--", cmd, ...args],
    env,
  };
}
