// The nodes that the Sessions and Instances views show. An empty selection means all nodes.

export const NODE_FILTER_KEY = "claude-rc-nodes";

export const toggleNode = (selected: readonly string[], id: string): string[] =>
  selected.includes(id) ? selected.filter((text) => text !== id) : [...selected, id];

/** The selection without the ids that are no longer nodes. */
export const pruneNodes = (selected: readonly string[], hosts: readonly { id: string }[]): string[] =>
  selected.filter((id) => hosts.some((host) => host.id === id));

export const inFilter = (selected: readonly string[], id: string): boolean =>
  selected.length === 0 || selected.includes(id);

// sessionStorage can be missing or throw (private windows, blocked storage); the views must work without it.
export function readNodes(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(NODE_FILTER_KEY) ?? "[]");
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
  } catch {
    return [];
  }
}

export function writeNodes(ids: readonly string[]): void {
  try {
    sessionStorage.setItem(NODE_FILTER_KEY, JSON.stringify(ids));
  } catch {
    // The storage can be blocked. Then the filter is not saved.
  }
}
