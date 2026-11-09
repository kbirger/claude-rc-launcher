import { chown, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { asUser, type IdentityFor } from "./asuser";
import type { Config } from "./config";
import { resolveChecked } from "./fsapi";
import { HttpError } from "./instances";
import { parseRepoLink } from "./repolink";
import type { Runner } from "./runner";

export type RepoGroup = { owner: string; repos: { name: string; private: boolean; pushedAt: string }[] };
/** Filled in by the login task. */
export type LoginSpawner = unknown;

export interface Cloner {
  clone(input: { repo: string; parent: string; user?: string }): Promise<{ path: string }>;
  repos(user?: string): Promise<{ groups: RepoGroup[] }>;
  loginStart(user?: string): Promise<{ id: string; code: string; url: string }>;
  loginStatus(id: string): Promise<{ state: "pending" | "done" | "failed"; error?: string }>;
}

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export function createCloner(deps: {
  cfg: Config;
  run: Runner;
  identityFor: IdentityFor;
  spawnLogin?: LoginSpawner;
  chownFn?: (path: string, uid: number, gid: number) => Promise<void>;
}): Cloner {
  const chownFn = deps.chownFn ?? chown;
  return {
    async clone({ repo, parent, user }) {
      const ref = parseRepoLink(repo);
      const id = await deps.identityFor(user);
      const resolved = await resolveChecked(parent, deps.cfg.roots);
      const target = join(resolved, ref.dirName);
      try {
        await mkdir(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "already exists");
        throw new HttpError(400, "cannot create directory");
      }
      const cleanup = () => rm(target, { recursive: true, force: true }).catch(() => {});
      try {
        if (id.uid !== undefined && id.gid !== undefined) {
          try {
            await chownFn(target, id.uid, id.gid);
          } catch (e) {
            console.error("chown of clone folder failed:", e);
            throw new HttpError(500, "cannot set directory owner");
          }
        }
        const w = asUser(id, "git", ["-c", "credential.helper=!gh auth git-credential", "clone", "--", ref.url, target]);
        const r = await deps.run(w.cmd, w.args, { env: w.env, timeoutMs: CLONE_TIMEOUT_MS });
        if (r.timedOut) throw new HttpError(504, "clone timed out");
        if (r.code === 127) throw new HttpError(400, `${w.cmd} is not installed`);
        if (r.code !== 0) {
          const first = r.stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? `exit ${r.code}`;
          throw new HttpError(400, `clone failed: ${first}`);
        }
        const real = await realpath(target);
        await resolveChecked(real, deps.cfg.roots);
        return { path: real };
      } catch (e) {
        await cleanup();
        throw e;
      }
    },
    async repos() { throw new HttpError(501, "not implemented"); },
    async loginStart() { throw new HttpError(501, "not implemented"); },
    async loginStatus() { throw new HttpError(501, "not implemented"); },
  };
}
