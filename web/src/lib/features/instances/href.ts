import { resolve } from "$app/paths";
import type { ResolvedPathname } from "$app/types";

/** Link to the Instances view. With a host it is the view of that one node (no node filter); without one it is the global view. */
export const instancesHref = (host?: string): ResolvedPathname =>
  host ? resolve(`/instances?host=${encodeURIComponent(host)}`) : resolve("/instances");
