import type { RepoGroup } from "./api";

// Case-insensitive substring match on the repo name. Groups with no match are dropped.
export function filterGroups(groups: RepoGroup[], query: string): RepoGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.map((g) => ({ ...g, repos: [...g.repos] }));
  return groups
    .map((g) => ({ ...g, repos: g.repos.filter((r) => r.name.toLowerCase().includes(q)) }))
    .filter((g) => g.repos.length > 0);
}
