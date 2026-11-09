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
const GH_TIMEOUT_MS = 60 * 1000;
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
        console.error("cannot create clone folder:", e);
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
        const w = asUser(id, "git", ["-c", "credential.helper=!gh auth git-credential", "clone", "-q", "--", ref.url, target]);
        const r = await deps.run(w.cmd, w.args, { env: w.env, timeoutMs: CLONE_TIMEOUT_MS });
        if (r.timedOut) throw new HttpError(504, "clone timed out");
        if (r.code === 127) {
          throw new HttpError(400, `${missingTool(w.cmd, r.stderr, "git")} is not installed`);
        }
        if (r.code !== 0) {
          const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
          const first = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1] ?? `exit ${r.code}`;
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
    async repos(user) {
      const id = await deps.identityFor(user);
      const gh = async (args: string[]) => {
        const w = asUser(id, "gh", args);
        const r = await deps.run(w.cmd, w.args, { env: w.env, timeoutMs: GH_TIMEOUT_MS });
        if (r.timedOut) throw new HttpError(504, "gh timed out");
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
      const groups: RepoGroup[] = [{ owner: login, repos: own }];
      for (const g of orgGroups) if (g) groups.push(g);
      return { groups };
    },
    async loginStart() { throw new HttpError(501, "not implemented"); },
    async loginStatus() { throw new HttpError(501, "not implemented"); },
  };
}
