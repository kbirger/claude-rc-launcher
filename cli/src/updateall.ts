import type { HostInfo } from "../../server/src/hosts";
import { RELEASE_TAG_RE } from "../../server/src/release";
import type { ClientResult, UpdateReport } from "../../server/src/serviceupdate";
import { VERSION } from "../../server/src/version";
import type { Flags } from "./args";
import { ExitError } from "./creds";
import { sanitizeLine, table } from "./format";
import { HubError } from "./hub";
import type { HubClient } from "./hub";
import { realSys } from "./nodesetup";
import type { Sys } from "./nodesetup";
import { selfUpdate } from "./update";

/** The hub forwards POST /update with 180 s and the server allows 190 s for update routes: wait longer than both. */
const UPDATE_TIMEOUT_MS = 200_000;
const POLL_TIMEOUT_MS = 5_000;
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 90_000;
const TOO_OLD = "cannot update remotely (node too old: run claude-rc node update on it once)";

export interface UpdateRow {
  machine: string;
  before: string;
  after: string;
  clients: string;
  status: string;
}

const OK = new Set(["updated", "up-to-date"]);

/** `--binary` cannot go to other machines: each one downloads its own release build. */
export function checkAllNodesFlags(flags: Flags): void {
  if (flags.binary)
    throw new ExitError(
      "--binary does not apply to update --all-nodes: every machine downloads its build from the release. Use --release <tag>",
      1,
    );

  if (flags.release !== undefined && !RELEASE_TAG_RE.test(flags.release)) {
    throw new ExitError(`--release must be a version tag such as v1.2.3 (got "${flags.release}")`, 1);
  }
}

const hostPath = (id: string) => `/cli/api/hosts/${encodeURIComponent(id)}`;

function clientText(clientResult: ClientResult): string {
  if (clientResult.status === "updated")
    return `${clientResult.path}: updated${clientResult.from || clientResult.to ? ` ${clientResult.from ?? "?"} -> ${clientResult.to ?? "?"}` : ""}`;
  if (clientResult.status === "failed") return `${clientResult.path}: failed`;
  return `${clientResult.path}: up-to-date`;
}

/** Polls GET .../node until the version differs from `from`, or 90 seconds pass. Errors are expected while it restarts. */
async function waitForNewVersion(
  hub: HubClient,
  sys: Sys,
  id: string,
  from: string,
): Promise<{ status: "updated" | "rolled back" | "no answer"; version?: string }> {
  const deadline = sys.now() + POLL_FOR_MS;
  let last: string | undefined;

  while (sys.now() < deadline) {
    await sys.sleep(POLL_EVERY_MS);

    try {
      const node = await hub.request<{ version?: string } | undefined>("GET", `${hostPath(id)}/node`, undefined, {
        timeoutMs: POLL_TIMEOUT_MS,
      });
      last = typeof node?.version === "string" ? node.version : undefined;
      if (last !== undefined && last !== from) return { status: "updated", version: last };
    } catch (error) {
      if (!(error instanceof ExitError)) throw error;
      last = undefined;
    }
  }

  // The node runs again, with the old version: the watchdog put the previous binary back.
  return last === from ? { status: "rolled back", version: from } : { status: "no answer" };
}

/** What a node of any age answers to an update. An older node can leave out `from` and `clients`. */
type HubReport = Omit<UpdateReport, "from" | "clients"> & { from?: string; clients?: ClientResult[] };

async function updateHost(
  hub: HubClient,
  sys: Sys,
  hostInfo: HostInfo,
  release: string | undefined,
  out: (value: string) => void,
): Promise<UpdateRow> {
  const row: UpdateRow = { machine: hostInfo.id, before: hostInfo.version ?? "?", after: "", clients: "", status: "" };
  if (hostInfo.status !== "ok")
    return { ...row, status: `skipped (${hostInfo.status}${hostInfo.error ? `: ${hostInfo.error}` : ""})` };
  out(`updating ${hostInfo.id} ...`);
  let report: HubReport;

  try {
    report = await hub.request<HubReport>(
      "POST",
      `${hostPath(hostInfo.id)}/update`,
      release !== undefined ? { release } : {},
      { timeoutMs: UPDATE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof HubError && error.status === 404) return { ...row, status: TOO_OLD };
    if (error instanceof ExitError) return { ...row, status: `failed (${error.message})` };
    throw error;
  }

  row.before = report.from ?? row.before;
  row.after = row.before;
  row.clients = (report.clients ?? []).map(clientText).join(", ");
  const failedClients = (report.clients ?? []).filter((clientResult) => clientResult.status === "failed");
  const clientFailure =
    failedClients.length > 0
      ? `failed (${failedClients.map((clientResult) => `${clientResult.path}: ${clientResult.error ?? "unknown error"}`).join("; ")})`
      : undefined;

  switch (report.status) {
    case "failed":
      return { ...row, status: `failed (${report.error ?? "unknown error"})` };
    case "up-to-date":
      return { ...row, status: clientFailure ?? "up-to-date" };
    case "clients-only":
      return { ...row, status: clientFailure ?? "updated" };

    case "restarting": {
      const forNewVersion = await waitForNewVersion(hub, sys, hostInfo.id, report.from ?? row.before);
      if (forNewVersion.status === "updated")
        return { ...row, after: forNewVersion.version ?? "?", status: clientFailure ?? "updated" };
      return { ...row, after: forNewVersion.version ?? "?", status: forNewVersion.status };
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
    await selfUpdate({
      flags: { ...(flags.release !== undefined ? { release: flags.release } : {}) },
      out: (line) => lines.push(line),
      sys,
    });
  } catch (error) {
    if (error instanceof ExitError) return { ...row, status: `failed (${error.message})` };
    throw error;
  }

  const last = lines.at(-1) ?? "";
  const match = / from \S+ to (\S+) /.exec(last);
  if (match) return { ...row, after: match[1], status: "updated" };
  return { ...row, status: "up-to-date" };
}

const STREAM_WAIT_MS = 2_000;
const STREAM_READY_MS = 3_000;

/**
 * Prints the `log` events of the hub for the machine that `current()` names, from the moment the stream opens (the
 * snapshot holds older lines and is ignored). A line of another machine, or one that arrives between two machines,
 * is dropped: it may be a replay after a hub restart or an update started from the web page. If the stream cannot be
 * opened (no route, an error), the watcher ends silently. A stream that opened and then ended, as when the hub
 * restarts, is reopened until it has been down for as long as the hub poll waits. `ready` runs on the first event
 * and when the open fails. Errors never escape.
 */
export async function watchLogs(
  hub: HubClient,
  sys: Sys,
  current: () => string | undefined,
  print: (value: string) => void,
  signal: AbortSignal,
  ready: () => void,
): Promise<void> {
  let downSince: number | undefined;
  let everOpened = false;
  // TypeScript narrows `signal.aborted` to false inside the loop, but an abort can come during any await.
  const aborted = (): boolean => signal.aborted;

  try {
    while (!signal.aborted) {
      try {
        for await (const ev of hub.stream("/cli/api/events", { signal })) {
          if (aborted()) return;
          everOpened = true;
          downSince = undefined;
          ready();
          if (ev.event !== "log") continue;

          try {
            const parsed = JSON.parse(ev.data) as { host?: unknown; line?: unknown };
            if (typeof parsed.host === "string" && typeof parsed.line === "string" && parsed.host === current())
              print(`[${parsed.host}] ${sanitizeLine(parsed.line)}`);
          } catch {
            /* a bad event is skipped */
          }
        }
      } catch {
        /* handled below */
      }

      ready();
      if (aborted() || !everOpened) return;
      downSince ??= sys.now();
      if (sys.now() - downSince > POLL_FOR_MS) return;
      // The run may end during this wait: stop at once, so a sleeping watcher cannot keep the process open.
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };

        signal.addEventListener("abort", done, { once: true });
        void sys.sleep(STREAM_WAIT_MS).then(done, done);
      });
    }
  } finally {
    ready();
  }
}

/**
 * `claude-rc update --all-nodes`: updates every remote host the hub knows, then the hub itself (`local`, which
 * restarts and drops the connection), then this client. One failed machine does not stop the others.
 */
export async function updateAll(options: {
  flags: Flags;
  hub: HubClient;
  out: (line: string) => void;
  err?: (line: string) => void;
  sys?: Sys;
}): Promise<void> {
  const { flags, hub, out } = options;
  const sys = options.sys ?? realSys;
  checkAllNodesFlags(flags);
  const progress = flags.json ? () => {} : out;

  const hosts = await hub.request<HostInfo[]>("GET", "/cli/api/hosts");
  const local = hosts.find((hostInfo) => hostInfo.id === "local") ?? {
    id: "local",
    name: "local",
    status: "ok" as const,
    stale: false,
  };
  const rows: UpdateRow[] = [];
  const stop = new AbortController();
  const err =
    options.err ??
    ((line: string) => {
      console.error(line);
    });
  // The watcher never rejects and never changes a result. It is not awaited: it may sleep between two attempts.
  // Only lines of the machine being updated now are printed. `current` is unset between machines and for the client.
  let current: string | undefined;
  let ready!: () => void;
  const opened = new Promise<void>((res) => (ready = res));
  void watchLogs(hub, sys, () => current, flags.json ? err : out, stop.signal, ready).catch(() => {});

  const update = async (hostInfo: HostInfo) => {
    current = hostInfo.status === "ok" ? hostInfo.id : undefined;

    try {
      return await updateHost(hub, sys, hostInfo, flags.release, progress);
    } finally {
      current = undefined;
    }
  };

  try {
    // The GET is sent but not answered at once: wait for the first event so the first lines are not lost.
    await Promise.race([opened, sys.sleep(STREAM_READY_MS)]);
    for (const hostInfo of hosts.filter((host) => host.id !== "local")) rows.push(await update(hostInfo));
    rows.push(await update(local));
    progress("updating this client ...");
    rows.push(await updateClient(flags, sys));
  } finally {
    stop.abort();
  }

  if (flags.json) out(JSON.stringify(rows, null, 2));
  else {
    out(
      table([
        ["MACHINE", "BEFORE", "AFTER", "CLIENTS", "STATUS"],
        ...rows.map((updateRow) => [
          updateRow.machine,
          updateRow.before,
          updateRow.after,
          updateRow.clients,
          updateRow.status,
        ]),
      ]),
    );

    if (rows.some((updateRow) => updateRow.status === "rolled back" || updateRow.status === "no answer")) {
      out(
        "For a machine that rolled back or did not answer, read the service log on it: journalctl -u claude-rc-launcher",
      );
    }
  }

  const bad = rows.filter((updateRow) => !OK.has(updateRow.status)).length;
  if (bad > 0) throw new ExitError(`${bad} of ${rows.length} machines were not updated`, 1);
}
