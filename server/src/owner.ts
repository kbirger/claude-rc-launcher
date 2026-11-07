import type { Config } from "./config";
import type { DirOwner } from "./fsapi";
import { bunRunner } from "./instances";

/** Folders created via the UI must be owned by the service user when we run as root for another user. */
export async function resolveDirOwner(cfg: Config): Promise<DirOwner | undefined> {
  if (process.getuid?.() !== 0 || cfg.serviceUser === "root") return undefined;
  const num = async (flag: "-u" | "-g") => {
    const r = await bunRunner("id", [flag, cfg.serviceUser]);
    const n = Number(r.stdout.trim());
    if (r.code !== 0 || !Number.isInteger(n) || n < 0) {
      throw new Error(`cannot resolve instance.service_user "${cfg.serviceUser}" (id ${flag}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return n;
  };
  return { uid: await num("-u"), gid: await num("-g") };
}
