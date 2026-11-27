/**
 * The part of the host registry that the hub copy of the session lists and the beat read. `HostRegistry` (hosts) has
 * this shape. The sessions feature names only what it uses, so it does not import hosts.
 */
export interface HostList {
  list(): { host: { id: string; name: string } }[];
  get(id: string):
    | {
        host: { name: string };
        client: {
          call(method: "POST", path: string, options?: { json?: unknown; timeoutMs?: number }): Promise<unknown>;
        };
      }
    | undefined;
  onChange(fn: (change: { type: "added" | "removed" | "renamed"; id: string }) => void): () => void;
}
