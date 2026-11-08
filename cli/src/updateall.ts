import type { Flags } from "./args";
import { ExitError } from "./creds";
import { table } from "./format";
import { HubError, type HubClient } from "./hub";
import { realSys, type Sys } from "./nodesetup";
import { selfUpdate } from "./update";
import { RELEASE_TAG_RE } from "../../server/src/release";
import { VERSION } from "../../server/src/version";
import type { HostInfo } from "../../server/src/hosts";
import type { ClientResult, UpdateReport } from "../../server/src/serviceupdate";

/** The hub forwards POST /update with 180 s and the server allows 190 s for update routes: wait longer than both. */
const UPDATE_TIMEOUT_MS = 200_000;
const POLL_TIMEOUT_MS = 5_000;
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 90_000;
const TOO_OLD = "cannot update remotely (node too old: run claude-rc node update on it once)";

export type UpdateRow = { machine: string; before: string; after: string; clients: string; status: string };

const OK = new Set(["updated", "up-to-date"]);

/** `--binary` cannot go to other machines: each one downloads its own release build. */
export function checkAllNodesFlags(flags: Flags): void {
  if (flags.binary) throw new ExitError("--binary does not apply to update --all-nodes: every machine downloads its build from the release. Use --release <tag>", 1);
  if (flags.release !== undefined && !RELEASE_TAG_RE.test(flags.release)) {
    throw new ExitError(`--release must be a version tag such as v1.2.3 (got "${flags.release}")`, 1);
  }
}

const hostPath = (id: string) => `/cli/api/hosts/${encodeURIComponent(id)}`;

function clientText(c: ClientResult): string {
  if (c.status === "updated") return `${c.path}: updated${c.from || c.to ? ` ${c.from ?? "?"} -> ${c.to ?? "?"}` : ""}`;
  if (c.status === "failed") return `${c.path}: failed`;
  return `${c.path}: up-to-date`;
}

/** Polls GET .../node until the version differs from `from`, or 90 seconds pass. Errors are expected while it restarts. */
async function waitForNewVersion(hub: HubClient, sys: Sys, id: string, from: string): Promise<{ status: "updated" | "rolled back" | "no answer"; version?: string }> {
  const deadline = sys.now() + POLL_FOR_MS;
  let last: string | undefined;
  while (sys.now() < deadline) {
    await sys.sleep(POLL_EVERY_MS);
    try {
      const node = await hub.request<{ version?: string }>("GET", `${hostPath(id)}/node`, undefined, { timeoutMs: POLL_TIMEOUT_MS });
      last = typeof node?.version === "string" ? node.version : undefined;
      if (last !== undefined && last !== from) return { status: "updated", version: last };
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
      last = undefined;
    }
  }
  // The node runs again, with the old version: the watchdog put the previous binary back.
  return last === from ? { status: "rolled back", version: from } : { status: "no answer" };
}

async function updateHost(hub: HubClient, sys: Sys, h: HostInfo, release: string | undefined, out: (s: string) => void): Promise<UpdateRow> {
  const row: UpdateRow = { machine: h.id, before: h.version ?? "?", after: "", clients: "", status: "" };
  if (h.status !== "ok") return { ...row, status: `skipped (${h.status}${h.error ? `: ${h.error}` : ""})` };
  out(`updating ${h.id} ...`);
  let report: UpdateReport;
  try {
    report = await hub.request<UpdateReport>("POST", `${hostPath(h.id)}/update`, release !== undefined ? { release } : {}, { timeoutMs: UPDATE_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof HubError && e.status === 404) return { ...row, status: TOO_OLD };
    if (e instanceof ExitError) return { ...row, status: `failed (${e.message})` };
    throw e;
  }
  row.before = report.from ?? row.before;
  row.after = row.before;
  row.clients = (report.clients ?? []).map(clientText).join(", ");
  const failedClients = (report.clients ?? []).filter((c) => c.status === "failed");
  const clientFailure = failedClients.length > 0 ? `failed (${failedClients.map((c) => `${c.path}: ${c.error ?? "unknown error"}`).join("; ")})` : undefined;

  switch (report.status) {
    case "failed":
      return { ...row, status: `failed (${report.error ?? "unknown error"})` };
    case "up-to-date":
      return { ...row, status: clientFailure ?? "up-to-date" };
    case "clients-only":
      return { ...row, status: clientFailure ?? "updated" };
    case "restarting": {
      const r = await waitForNewVersion(hub, sys, h.id, report.from);
      if (r.status === "updated") return { ...row, after: r.version!, status: clientFailure ?? "updated" };
      return { ...row, after: r.version ?? "?", status: r.status };
    }
    default:
      return { ...row, status: `failed (unexpected answer: ${String((report as { status?: unknown }).status)})` };
  }
}

/** Updates this client binary through `claude-rc update` and turns its last message into a row. */
async function updateClient(flags: Flags, sys: Sys): Promise<UpdateRow> {
  const lines: string[] = [];
  const exe = sys.execPath ?? process.execPath;
  const row: UpdateRow = { machine: "client", before: VERSION, after: VERSION, clients: exe, status: "" };
  try {
    await selfUpdate({ flags: { ...(flags.release !== undefined ? { release: flags.release } : {}) }, out: (s) => lines.push(s), sys });
  } catch (e) {
    if (e instanceof ExitError) return { ...row, status: `failed (${e.message})` };
    throw e;
  }
  const last = lines.at(-1) ?? "";
  const m = / from \S+ to (\S+) /.exec(last);
  if (m) return { ...row, after: m[1]!, status: "updated" };
  return { ...row, status: "up-to-date" };
}

/**
 * `claude-rc update --all-nodes`: updates every remote host the hub knows, then the hub itself (`local`, which
 * restarts and drops the connection), then this client. One failed machine does not stop the others.
 */
export async function updateAll(o: { flags: Flags; hub: HubClient; out: (s: string) => void; sys?: Sys }): Promise<void> {
  const { flags, hub, out } = o;
  const sys = o.sys ?? realSys;
  checkAllNodesFlags(flags);
  const progress = flags.json ? () => {} : out;

  const hosts = await hub.request<HostInfo[]>("GET", "/cli/api/hosts");
  const local = hosts.find((h) => h.id === "local") ?? { id: "local", name: "local", status: "ok" as const };
  const rows: UpdateRow[] = [];
  for (const h of hosts.filter((h) => h.id !== "local")) rows.push(await updateHost(hub, sys, h, flags.release, progress));
  rows.push(await updateHost(hub, sys, local, flags.release, progress));
  progress("updating this client ...");
  rows.push(await updateClient(flags, sys));

  if (flags.json) out(JSON.stringify(rows, null, 2));
  else {
    out(table([["MACHINE", "BEFORE", "AFTER", "CLIENTS", "STATUS"], ...rows.map((r) => [r.machine, r.before, r.after, r.clients, r.status])]));
    if (rows.some((r) => r.status === "rolled back" || r.status === "no answer")) {
      out("For a machine that rolled back or did not answer, read the service log on it: journalctl -u claude-rc-launcher");
    }
  }
  const bad = rows.filter((r) => !OK.has(r.status)).length;
  if (bad > 0) throw new ExitError(`${bad} of ${rows.length} machines were not updated`, 1);
}
