/** Link to the Instances view. With a host it is the view of that one node (no node filter); without one it is the global view. */
export const instancesHref = (host?: string): string => (host ? `/instances?host=${encodeURIComponent(host)}` : "/instances");
