import { lstat, mkdir, realpath, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { asUser } from "./shared/asuser";
import type { IdentityFor } from "./shared/asuser";
import type { Config } from "./config/parse";
import { resolveChecked } from "./fsapi";
import type { DirOwner } from "./fsapi";
import { createLoginManager } from "./ghlogin";
import type { LoginClock, LoginSpawner } from "./ghlogin";
import { bunRunner, HttpError, InstanceService } from "./instances";
import type { Instances } from "./instances";
import { adoptNewDir, DirChanged } from "./ownedir";
import type { AdoptDir, AdoptedDir } from "./ownedir";
import { parseRepoLink } from "./repolink";
import type { Runner } from "./shared/runner";

export interface RepoGroup {
  owner: string;
  repos: { name: string; private: boolean; pushedAt: string }[];
}

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
interface CloneJob {
  state: "running" | "done" | "failed";
  path?: string;
  error?: string;
}
/** The trust step must not keep a clone job running. */
const TRUST_TIMEOUT_MS = 30 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
/** The whole repo list must answer before the hub gives up on the request (120 s). */
const REPO_LIST_DEADLINE_MS = 100 * 1000;
const LOGIN_REQUIRED = "GitHub login required for this repository. Sign in to GitHub on this machine";
const REPO_LIST_PARALLEL = 4;

/** Names the tool behind an exit 127. setpriv exits 127 too when it cannot exec its target; a spawn failure of setpriv itself has other text. */
function missingTool(cmd: string, stderr: string, tool: string): string {
  const name = cmd.split("/").pop() ?? cmd;
  return name === "setpriv" && /failed to execute/i.test(stderr) ? tool : name;
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean) ?? "";

async function mapLimit<Value, Result>(
  items: Value[],
  limit: number,
  fn: (value: Value) => Promise<Result>,
): Promise<Result[]> {
  const out = new Array<Result>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function parseRepoList(stdout: string): RepoGroup["repos"] {
  let data: unknown;

  try {
    data = JSON.parse(stdout);
  } catch {
    throw new HttpError(502, "unexpected output from gh");
  }

  if (!Array.isArray(data)) throw new HttpError(502, "unexpected output from gh");
  const repos = data.map((raw) => {
    const repo = raw as { nameWithOwner?: unknown; isPrivate?: unknown; pushedAt?: unknown } | null;

    if (
      !repo ||
      typeof repo.nameWithOwner !== "string" ||
      typeof repo.isPrivate !== "boolean" ||
      (repo.pushedAt != null && typeof repo.pushedAt !== "string")
    ) {
      throw new HttpError(502, "unexpected output from gh");
    }

    return { name: repo.nameWithOwner, private: repo.isPrivate, pushedAt: repo.pushedAt ?? "" };
  });

  const time = (text: string) => {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };

  return repos.sort((repo, right) => {
    const ta = time(repo.pushedAt),
      tb = time(right.pushedAt);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return repo.name < right.name ? -1 : repo.name > right.name ? 1 : 0;
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
  const logins = createLoginManager({
    run: deps.run,
    identityFor: deps.identityFor,
    spawn: deps.spawnLogin,
    clock: deps.loginClock,
    missingTool,
  });
  const clock: LoginClock = deps.loginClock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  };
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
      const user = asUser(id, "rm", ["-rf", "--", target]);
      const runResult = await deps.run(user.cmd, user.args, { env: user.env, timeoutMs: CLEANUP_TIMEOUT_MS });
      if (runResult.code !== 0)
        rmError = runResult.timedOut ? "timed out" : firstLine(runResult.stderr) || `exit ${runResult.code}`;
    } catch (error) {
      rmError = firstLine(String(error));
    }

    // The user cannot remove the folder itself from a parent that root owns. This removes it only if it is empty.
    await rmdir(target).catch((caught: unknown) => {
      const errnoException = caught as NodeJS.ErrnoException;
      if (errnoException.code === "ENOENT") return;

      if (errnoException.code === "ENOTEMPTY" || errnoException.code === "EEXIST") {
        console.error(`cleanup of failed clone ${target} left files: ${rmError || "folder not empty"}`);
        return;
      }

      console.error(`cleanup of failed clone ${target}: ${errnoException.code ?? errnoException.message}`);
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
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "already exists");
        console.error("cannot create clone folder:", caught);
        throw new HttpError(400, "cannot create directory");
      }

      active.add(target);

      // Only an empty folder is removed here: git has not run yet.
      const refuse = async (msg: string, detail?: unknown) => {
        if (detail !== undefined) console.error(`${msg}:`, detail);
        await rmdir(target).catch(() => {});
        active.delete(target);
        throw new HttpError(500, msg);
      };

      const { uid, gid } = id;
      const hasUid = uid !== undefined && gid !== undefined;
      // The instance user can write to the parent, so it can swap the folder before the owner change.
      // adoptDir checks the folder through an open handle and changes the owner through that same handle.
      let adopted: AdoptedDir | undefined;

      if (hasUid) {
        try {
          adopted = await adoptDir(target, { uid, gid });
        } catch (error) {
          if (error instanceof DirChanged) await refuse("clone folder changed", error);
          await refuse("cannot set directory owner", error);
        }
      }

      // A second check by path before git runs: the path must still name that folder.
      let ok = false;

      try {
        const st = await lstat(target);
        const uid = process.getuid?.();
        ok =
          st.isDirectory() &&
          !st.isSymbolicLink() &&
          (adopted ? st.dev === adopted.dev && st.ino === adopted.ino : uid === undefined || st.uid === uid);
      } catch {}

      if (!ok) await refuse("clone folder changed");
      const jobId = crypto.randomUUID().replaceAll("-", "");
      const job: CloneJob = { state: "running" };
      jobs.set(jobId, job);

      const work = async () => {
        const harness = asUser(id, "git", [
          "-c",
          "credential.helper=!gh auth git-credential",
          "clone",
          "-q",
          "--",
          ref.url,
          target,
        ]);
        const runResult = await deps.run(harness.cmd, harness.args, { env: harness.env, timeoutMs: CLONE_TIMEOUT_MS });
        if (runResult.timedOut) throw new HttpError(504, "clone timed out");

        if (runResult.code === 127) {
          throw new HttpError(400, `${missingTool(harness.cmd, runResult.stderr, "git")} is not installed`);
        }

        // A private repo with no usable login: git wanted to ask for a user name.
        if (runResult.code !== 0 && /could not read Username|terminal prompts disabled/i.test(runResult.stderr))
          throw new HttpError(400, LOGIN_REQUIRED);

        if (runResult.code !== 0) {
          const lines = runResult.stderr
            .split("\n")
            .map((part) => part.trim())
            .filter(Boolean);
          const first = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1) ?? `exit ${runResult.code}`;
          throw new HttpError(400, `clone failed: ${first}`);
        }

        const real = await realpath(target);
        await resolveChecked(real, deps.cfg.roots);

        // Before the job is done, so the client never starts an instance ahead of the trust. A failure leaves the normal trust question.
        // Trust only the folder this job created: the user can swap it for a symlink while git runs.
        const same = async () => {
          if (real !== target) return false;
          const st = await lstat(target);
          return (
            st.isDirectory() && !st.isSymbolicLink() && (!adopted || (st.dev === adopted.dev && st.ino === adopted.ino))
          );
        };

        let timer: unknown;

        try {
          if (deps.trustFolder) {
            if (!(await same().catch(() => false))) throw new Error("folder changed");
            const limit = new Promise<never>((_unused, rej) => {
              timer = clock.setTimeout(() => {
                rej(new Error("timed out"));
              }, TRUST_TIMEOUT_MS);
            });
            await Promise.race([deps.trustFolder(user, real), limit]);
          }
        } catch (caught) {
          console.error(
            `cannot trust cloned folder ${real}: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        } finally {
          if (timer !== undefined) clock.clearTimeout(timer);
        }

        return real;
      };

      void work()
        .then(
          (real) => {
            job.path = real;
            job.state = "done";
          },
          async (entry: unknown) => {
            await removeTarget(id, target);
            job.error = entry instanceof HttpError ? entry.message : "clone failed";
            if (!(entry instanceof HttpError)) console.error("clone failed:", entry);
            job.state = "failed";
          },
        )
        .catch((error: unknown) => {
          console.error("clone job error:", error);
          job.state = "failed";
          job.error ??= "clone failed";
        })
        .finally(() => {
          active.delete(target);
          clock.setTimeout(() => {
            jobs.delete(jobId);
          }, CLONE_FORGET_MS);
        });
      return { id: jobId, path: target };
    },
    cloneStatus(id) {
      const response = jobs.get(id);
      if (!response) return Promise.reject(new HttpError(404, "unknown clone"));
      return Promise.resolve({
        state: response.state,
        ...(response.path !== undefined ? { path: response.path } : {}),
        ...(response.error !== undefined ? { error: response.error } : {}),
      });
    },
    async repos(user) {
      const id = await deps.identityFor(user);
      const deadline = now() + REPO_LIST_DEADLINE_MS;
      let expired = false;
      // A function, so that TypeScript does not narrow `expired` to false: `gh` sets it while the lists load.
      const isExpired = () => expired;

      const gh = async (args: string[]) => {
        const left = deadline - now();

        if (left <= 0) {
          expired = true;
          throw new HttpError(504, "gh timed out");
        }

        const harness = asUser(id, "gh", args);
        const runResult = await deps.run(harness.cmd, harness.args, {
          env: harness.env,
          timeoutMs: Math.min(GH_TIMEOUT_MS, left),
        });

        if (runResult.timedOut) {
          // A call cut short by the deadline, not by its own 60 s limit, also ends the whole list.
          if (left < GH_TIMEOUT_MS) expired = true;
          throw new HttpError(504, "gh timed out");
        }

        if (runResult.code === 127)
          throw new HttpError(500, `${missingTool(harness.cmd, runResult.stderr, "gh")} is not installed`);

        if (runResult.code === 4 || runResult.stderr.includes("gh auth login")) {
          throw new HttpError(409, "GitHub login required", { code: "github-login-required" });
        }

        if (runResult.code !== 0)
          throw new HttpError(502, `gh failed: ${firstLine(runResult.stderr) || `exit ${runResult.code}`}`);
        return runResult.stdout;
      };

      const list = (owner?: string) =>
        gh([
          "repo",
          "list",
          "--limit",
          "200",
          "--json",
          "nameWithOwner,isPrivate,pushedAt",
          ...(owner ? ["--", owner] : []),
        ]).then(parseRepoList);
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      if (!login) throw new HttpError(502, "unexpected output from gh");
      const orgs = (await gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]))
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean)
        .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
      const own = await list();
      const orgGroups = await mapLimit(orgs, REPO_LIST_PARALLEL, async (org): Promise<RepoGroup | null> => {
        try {
          const repos = await list(org);
          return repos.length ? { owner: org, repos } : null;
        } catch (caught) {
          console.error(
            `repo list for ${org} failed: ${caught instanceof HttpError ? caught.message : firstLine(String(caught))}`,
          );
          return null;
        }
      });
      // A skipped org is fine, but a list cut short by the deadline is not: fail instead of a partial answer.
      if (isExpired()) throw new HttpError(504, "gh timed out");
      const groups: RepoGroup[] = [{ owner: login, repos: own }];
      for (const orgGroup of orgGroups) if (orgGroup) groups.push(orgGroup);
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
  cfg: Config,
  instances: Instances,
  dirOwner: DirOwner | undefined,
  run: Runner = bunRunner,
  /** Extra `createCloner` deps, for tests. Production call sites pass none. */
  extra: { adoptDir?: AdoptDir } = {},
): Cloner | undefined {
  if (!(instances instanceof InstanceService)) return undefined;

  const identityFor: IdentityFor = async (user) => {
    const id = await instances.identityFor(user);
    return id.uid !== undefined ? id : { ...id, ...(dirOwner ?? {}) };
  };

  return createCloner({
    cfg,
    run,
    identityFor,
    ...extra,
    trustFolder: (path, uid) => instances.trustFolder(path, uid),
  });
}
