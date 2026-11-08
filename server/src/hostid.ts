/**
 * The format of a host id. This is the only definition. The configuration loader, the forwarding router, the host
 * registry, the host admin API and the CLI all use it, so a change here applies everywhere. The module has no
 * imports on purpose, so the CLI can read it without pulling in the server.
 */
export const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
