export type Identity = { home: string; path: string; uid?: number; gid?: number };
export type IdentityFor = (user?: string) => Promise<Identity>;

/** Wraps a command so it runs as the identity's user. The env REPLACES the child's whole environment. */
export function asUser(id: Identity, cmd: string, args: string[]): { cmd: string; args: string[]; env: Record<string, string> } {
  const env = {
    HOME: id.home,
    PATH: id.path,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    LANG: "C.UTF-8",
  };
  if (id.uid === undefined || id.gid === undefined) return { cmd, args, env };
  return { cmd: "setpriv", args: ["--reuid", String(id.uid), "--regid", String(id.gid), "--init-groups", "--", cmd, ...args], env };
}
