// Prints the version to bake into the binaries. Usage: bun scripts/version.ts
// A release sets RELEASE_VERSION to the tag. A local build uses the last tag plus the branch and short commit.
import { execFileSync } from "node:child_process";

type Inputs = { env: Record<string, string | undefined>; git: (args: string[]) => string | null };

export function computeVersion({ env, git }: Inputs): string {
  if (env.RELEASE_VERSION) return env.RELEASE_VERSION.replace(/^v/, "");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const changes = git(["status", "--porcelain", "--untracked-files=no"]);
  if (branch === null || sha === null || changes === null) return "dev";
  const base = (git(["describe", "--tags", "--abbrev=0"]) ?? "0.0.0").replace(/^v/, "");
  const name = branch === "HEAD" ? "detached" : branch.replace(/[^A-Za-z0-9.-]/g, "-");
  return `${base}+${name}.${sha}${changes ? ".dirty" : ""}`;
}

function runGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

if (import.meta.main) process.stdout.write(computeVersion({ env: process.env, git: runGit }));
