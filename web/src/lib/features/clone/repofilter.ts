import type { RepoGroup } from "./api";

// Case-insensitive substring match on the repo name. Groups with no match are dropped.
export function filterGroups(groups: RepoGroup[], query: string): RepoGroup[] {
  const lowered = query.trim().toLowerCase();
  if (!lowered) return groups.map((group) => ({ ...group, repos: [...group.repos] }));
  return groups
    .map((group) => ({ ...group, repos: group.repos.filter((repo) => repo.name.toLowerCase().includes(lowered)) }))
    .filter((item) => item.repos.length > 0);
}
