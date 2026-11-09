import { lstat, mkdir, realpath, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { asUser, type IdentityFor } from "./asuser";
import type { Config } from "./config";
import { createLoginManager, type LoginClock, type LoginSpawner } from "./ghlogin";
import { resolveChecked } from "./fsapi";
import type { DirOwner } from "./fsapi";
import { bunRunner, HttpError, InstanceService, type Instances } from "./instances";
import { adoptNewDir, type AdoptDir, type AdoptedDir, DirChanged } from "./ownedir";
import { parseRepoLink } from "./repolink";
import type { Runner } from "./runner";

export type RepoGroup = { owner: string; repos: { name: string; private: boolean; pushedAt: string }[] };

export interface Cloner {
  cloneStart(input: { repo: string; parent: string; user?: string }): Promise<{ id: string; path: string }>;
  cloneStatus(id: string): Promise<{ state: "running" | "done" | "failed"; path?: string; error?: string }>;
  repos(user?: string): Promise<{ groups: RepoGroup[] }>;
  loginStart(user?: string): Promise<{ id: string; code: string; url: string }>;
  loginStatus(id: string): Promise<{ state: "pending" | "done" | "failed"; error?: string }>;
  /** The real paths of the folders that a clone is still writing to. */
  activeClones(): string[];
}

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const CLONE_FORGET_MS = 10 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;
type CloneJob = { state: "running" | "done" | "failed"; path?: string; error?: string };
/** The trust step must not keep a clone job running. */
const TRUST_TIMEOUT_MS = 30 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
/** The whole repo list must answer before the hub gives up on the request (120 s). */
const REPO_LIST_DEADLINE_MS = 100 * 1000;
const LOGIN_REQUIRED = "GitHub login required for this repository. Sign in to GitHub on this machine";
const REPO_LIST_PARALLEL = 4;

/** Names the tool behind an exit 127. setpriv exits 127 too when it cannot exec its target; a spawn failure of setpriv itself has other text. */
function missingTool(cmd: string, stderr: string, tool: string): string {
  return cmd === "setpriv" && /failed to execute/i.test(stderr) ? tool : cmd;
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function parseRepoList(stdout: string): RepoGroup["repos"] {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { throw new HttpError(502, "unexpected output from gh"); }
  if (!Array.isArray(data)) throw new HttpError(502, "unexpected output from gh");
  const repos = data.map((d) => {
    const r = d as { nameWithOwner?: unknown; isPrivate?: unknown; pushedAt?: unknown } | null;
    if (!r || typeof r.nameWithOwner !== "string" || typeof r.isPrivate !== "boolean" ||
      (r.pushedAt != null && typeof r.pushedAt !== "string")) {
      throw new HttpError(502, "unexpected output from gh");
    }
    return { name: r.nameWithOwner, private: r.isPrivate, pushedAt: r.pushedAt ?? "" };
  });
  const time = (s: string) => { const t = Date.parse(s); return Number.isNaN(t) ? -Infinity : t; };
  return repos.sort((a, b) => {
    const ta = time(a.pushedAt), tb = time(b.pushedAt);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function createCloner(deps: {
  cfg: Config;
  run: Runner;
  identityFor: IdentityFor;
  spawnLogin?: LoginSpawner;
  loginClock?: LoginClock;
  /** Gives the new folder to the user through an open handle, after checking it (the default is `adoptNewDir`). */
  adoptDir?: AdoptDir;
  /** Adds the new folder to the trust list of the clone's user. A failure does not fail the clone. */
  trustFolder?: (user: string | undefined, path: string) => Promise<void>;
  /** Milliseconds, for the repo list deadline. */
  now?: () => number;
}): Cloner {
  const now = deps.now ?? Date.now;
  const adoptDir = deps.adoptDir ?? adoptNewDir;
  const logins = createLoginManager({ run: deps.run, identityFor: deps.identityFor, spawn: deps.spawnLogin, clock: deps.loginClock, missingTool });
  const clock: LoginClock = deps.loginClock ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  const jobs = new Map<string, CloneJob>();
  const active = new Set<string>();
  /** Removes the folder, and never as root: the instance user controls it, so a recursive walk as root is not safe. */
  const removeTarget = async (id: Awaited<ReturnType<IdentityFor>>, target: string) => {
    if (id.uid === undefined || id.gid === undefined) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      return;
    }
    let rmError = "";
    try {
      // GNU rm works relative to open folders, so a folder swapped for a symlink during the walk is not followed.
      const w = asUser(id, "rm", ["-rf", "--", target]);
      const r = await deps.run(w.cmd, w.args, { env: w.env, timeoutMs: CLEANUP_TIMEOUT_MS });
      if (r.code !== 0) rmError = r.timedOut ? "timed out" : firstLine(r.stderr) || `exit ${r.code}`;
    } catch (e) {
      rmError = firstLine(String(e));
    }
    // The user cannot remove the folder itself from a parent that root owns. This removes it only if it is empty.
    await rmdir(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return;
      if (e.code === "ENOTEMPTY" || e.code === "EEXIST") {
        console.error(`cleanup of failed clone ${target} left files: ${rmError || "folder not empty"}`);
        return;
      }
      console.error(`cleanup of failed clone ${target}: ${e.code ?? e.message}`);
    });
  };
  return {
    async cloneStart({ repo, parent, user }) {
      const ref = parseRepoLink(repo);
      const id = await deps.identityFor(user);
      const resolved = await resolveChecked(parent, deps.cfg.roots);
      const target = join(resolved, ref.dirName);
      try {
        await mkdir(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "already exists");
        console.error("cannot create clone folder:", e);
        throw new HttpError(400, "cannot create directory");
      }
      active.add(target);
      // Only an empty folder is removed here: git has not run yet.
      const refuse = async (msg: string, e?: unknown) => {
        if (e !== undefined) console.error(`${msg}:`, e);
        await rmdir(target).catch(() => {});
        active.delete(target);
        throw new HttpError(500, msg);
      };
      const hasUid = id.uid !== undefined && id.gid !== undefined;
      // The instance user can write to the parent, so it can swap the folder before the owner change.
      // adoptDir checks the folder through an open handle and changes the owner through that same handle.
      let adopted: AdoptedDir | undefined;
      if (hasUid) {
        try {
          adopted = await adoptDir(target, { uid: id.uid!, gid: id.gid! });
        } catch (e) {
          if (e instanceof DirChanged) await refuse("clone folder changed", e);
          await refuse("cannot set directory owner", e);
        }
      }
      // A second check by path before git runs: the path must still name that folder.
      let ok = false;
      try {
        const st = await lstat(target);
        const uid = process.getuid?.();
        ok = st.isDirectory() && !st.isSymbolicLink() &&
          (adopted ? st.dev === adopted.dev && st.ino === adopted.ino : uid === undefined || st.uid === uid);
      } catch {}
      if (!ok) await refuse("clone folder changed");
      const jobId = crypto.randomUUID().replaceAll("-", "");
      const job: CloneJob = { state: "running" };
      jobs.set(jobId, job);
      const work = async () => {
        const w = asUser(id, "git", ["-c", "credential.helper=!gh auth git-credential", "clone", "-q", "--", ref.url, target]);
        const r = await deps.run(w.cmd, w.args, { env: w.env, timeoutMs: CLONE_TIMEOUT_MS });
        if (r.timedOut) throw new HttpError(504, "clone timed out");
        if (r.code === 127) {
          throw new HttpError(400, `${missingTool(w.cmd, r.stderr, "git")} is not installed`);
        }
        // A private repo with no usable login: git wanted to ask for a user name.
        if (r.code !== 0 && /could not read Username|terminal prompts disabled/i.test(r.stderr)) throw new HttpError(400, LOGIN_REQUIRED);
        if (r.code !== 0) {
          const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
          const first = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1] ?? `exit ${r.code}`;
          throw new HttpError(400, `clone failed: ${first}`);
        }
        const real = await realpath(target);
        await resolveChecked(real, deps.cfg.roots);
        // Before the job is done, so the client never starts an instance ahead of the trust. A failure leaves the normal trust question.
        // Trust only the folder this job created: the user can swap it for a symlink while git runs.
        const same = async () => {
          if (real !== target) return false;
          const st = await lstat(target);
          return st.isDirectory() && !st.isSymbolicLink() && (!adopted || (st.dev === adopted.dev && st.ino === adopted.ino));
        };
        let timer: unknown;
        try {
          if (deps.trustFolder) {
            if (!(await same().catch(() => false))) throw new Error("folder changed");
            const limit = new Promise<never>((_, rej) => {
              timer = clock.setTimeout(() => rej(new Error("timed out")), TRUST_TIMEOUT_MS);
            });
            await Promise.race([deps.trustFolder(user, real), limit]);
          }
        } catch (e) {
          console.error(`cannot trust cloned folder ${real}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (timer !== undefined) clock.clearTimeout(timer);
        }
        return real;
      };
      void work().then(
        (real) => { job.path = real; job.state = "done"; },
        async (e) => {
          await removeTarget(id, target);
          job.error = e instanceof HttpError ? e.message : "clone failed";
          if (!(e instanceof HttpError)) console.error("clone failed:", e);
          job.state = "failed";
        },
      ).catch((e) => { console.error("clone job error:", e); job.state = "failed"; job.error ??= "clone failed"; })
        .finally(() => {
          active.delete(target);
          clock.setTimeout(() => { jobs.delete(jobId); }, CLONE_FORGET_MS);
        });
      return { id: jobId, path: target };
    },
    async cloneStatus(id) {
      const j = jobs.get(id);
      if (!j) throw new HttpError(404, "unknown clone");
      return { state: j.state, ...(j.path !== undefined ? { path: j.path } : {}), ...(j.error !== undefined ? { error: j.error } : {}) };
    },
    async repos(user) {
      const id = await deps.identityFor(user);
      const deadline = now() + REPO_LIST_DEADLINE_MS;
      let expired = false;
      const gh = async (args: string[]) => {
        const left = deadline - now();
        if (left <= 0) {
          expired = true;
          throw new HttpError(504, "gh timed out");
        }
        const w = asUser(id, "gh", args);
        const r = await deps.run(w.cmd, w.args, { env: w.env, timeoutMs: Math.min(GH_TIMEOUT_MS, left) });
        if (r.timedOut) {
          // A call cut short by the deadline, not by its own 60 s limit, also ends the whole list.
          if (left < GH_TIMEOUT_MS) expired = true;
          throw new HttpError(504, "gh timed out");
        }
        if (r.code === 127) throw new HttpError(500, `${missingTool(w.cmd, r.stderr, "gh")} is not installed`);
        if (r.code === 4 || r.stderr.includes("gh auth login")) {
          throw new HttpError(409, "GitHub login required", { code: "github-login-required" });
        }
        if (r.code !== 0) throw new HttpError(502, `gh failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        return r.stdout;
      };
      const list = (owner?: string) =>
        gh(["repo", "list", "--limit", "200", "--json", "nameWithOwner,isPrivate,pushedAt", ...(owner ? ["--", owner] : [])]).then(parseRepoList);
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      if (!login) throw new HttpError(502, "unexpected output from gh");
      const orgs = (await gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]))
        .split("\n").map((l) => l.trim()).filter(Boolean)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const own = await list();
      const orgGroups = await mapLimit(orgs, REPO_LIST_PARALLEL, async (org): Promise<RepoGroup | null> => {
        try {
          const repos = await list(org);
          return repos.length ? { owner: org, repos } : null;
        } catch (e) {
          console.error(`repo list for ${org} failed: ${e instanceof HttpError ? e.message : firstLine(String(e))}`);
          return null;
        }
      });
      // A skipped org is fine, but a list cut short by the deadline is not: fail instead of a partial answer.
      if (expired) throw new HttpError(504, "gh timed out");
      const groups: RepoGroup[] = [{ owner: login, repos: own }];
      for (const g of orgGroups) if (g) groups.push(g);
      return { groups };
    },
    activeClones: () => [...active],
    loginStart: (user) => logins.start(user),
    loginStatus: (id) => logins.status(id),
  };
}

/**
 * The cloner of a real service host, or `undefined` for any other `Instances` (the Windows backend has none).
 * When the launcher runs as root for a non-root service user, the default identity is that user, not root.
 */
export function serviceCloner(
  cfg: Config, instances: Instances, dirOwner: DirOwner | undefined, run: Runner = bunRunner,
  /** Extra `createCloner` deps, for tests. Production call sites pass none. */
  extra: { adoptDir?: AdoptDir } = {},
): Cloner | undefined {
  if (!(instances instanceof InstanceService)) return undefined;
  const identityFor: IdentityFor = async (u) => {
    const id = await instances.identityFor(u);
    return id.uid !== undefined ? id : { ...id, ...(dirOwner ?? {}) };
  };
  return createCloner({ cfg, run, identityFor, ...extra, trustFolder: (u, p) => instances.trustFolder(u, p) });
}
