import { HubError } from "./hub";
import type { HubClient } from "./hub";
import { isObject } from "./json";

export const SSH_BASE = "/cli/api/ssh";
const POLL_MS = 2000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const STILL_WAITS = "The request still waits on the hub: deny it on the web page or wait for it to expire";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The grant ended or is gone: no request waits on the hub. */
class EndedError extends Error {}

export interface MaintenanceWork {
  action: "install" | "sources" | "uninstall";
  fromNodes?: string[];
  toNodes?: string[];
  result?: "done" | "failed";
  detail?: string;
}

/** A grant as the hub projects it. The answer of an approve can carry more fields, see below. */
export interface MaintenanceGrant {
  id: string;
  targetId?: string;
  state?: string;
  endReason?: string;
  maintenance?: MaintenanceWork;
  /** The approve of `sources`: the target with the stored list. */
  target?: { nodes?: string[]; systemType?: string };
  pushed?: boolean;
  /** The approve of `uninstall`: the retire answer. A failed run still retires. */
  retired?: { line?: string; detail?: string };
}

export interface MaintenanceDeps {
  hub: HubClient;
  hubUrl: string;
  /** The unlock method of the hub. */
  method: "prf" | "passphrase";
  readSecret: (prompt: string) => Promise<string>;
  out: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** The grant as a value of the type, or `undefined` when the hub sent something else. */
export function asGrant(value: unknown): MaintenanceGrant | undefined {
  return isObject(value) && typeof value.id === "string" ? (value as unknown as MaintenanceGrant) : undefined;
}

/**
 * Approves a maintenance grant and waits for its end. With a passphrase it asks for the secret and posts the approve:
 * the hub runs the command and answers when it is done. With a passkey it prints the link and polls the list of grants
 * until the grant ends. It returns the grant after a good run, and throws an `Error` with a plain text for everything
 * else (a failed run, a deny, an expiry, a grant that is gone, no end in 10 minutes). An uninstall counts as good when
 * the answer holds `retired`, because the hub retires the target after the owner approved, whatever the run gave.
 */
export async function approveMaintenance(
  grant: { id: string; targetId?: string },
  deps: MaintenanceDeps,
): Promise<MaintenanceGrant> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const id = encodeURIComponent(grant.id);
  let final: MaintenanceGrant | undefined;

  // A failure before the hub gave a result leaves the request on the hub: say so.
  try {
    if (deps.method === "passphrase") {
      deps.out("This change needs one approval with the provisioner key.");
      const typed = await deps.readSecret("Passphrase for the SSH keys: ");
      if (!typed) throw new Error("no passphrase");
      const unlock = { method: "passphrase", secret: Buffer.from(typed, "utf8").toString("base64url") };

      try {
        final = asGrant(await deps.hub.request("POST", `${SSH_BASE}/grants/${id}/approve`, { unlock }));
      } catch (error) {
        // A wrong passphrase leaves the grant pending. A failed run ends it.
        if (error instanceof HubError && error.status === 403) throw new Error(error.message);
        throw error;
      }
    } else {
      const target = grant.targetId === undefined ? "" : `?target=${encodeURIComponent(grant.targetId)}`;
      const link = `${deps.hubUrl.replace(/\/+$/, "")}/ssh${target}`;
      deps.out(`open ${link} and approve the change with your passkey (one approval)`);
      final = await waitForEnd(grant.id, link, deps, sleep);
    }
  } catch (error) {
    // A refusal of the hub other than 403 means that the request ended: a failed run, or a grant that is out of date.
    if (error instanceof HubError && error.status !== 403) throw error;
    if (error instanceof EndedError) throw error;
    throw new Error(`${messageOf(error)}. ${STILL_WAITS}`);
  }

  return judge(final);
}

async function waitForEnd(
  grantId: string,
  link: string,
  deps: MaintenanceDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<MaintenanceGrant> {
  for (let waited = 0; waited <= POLL_LIMIT_MS; waited += POLL_MS) {
    const list = await deps.hub.request<unknown>("GET", `${SSH_BASE}/grants`);
    const found = Array.isArray(list) ? list.map(asGrant).find((item) => item?.id === grantId) : undefined;
    if (!found)
      throw new EndedError(
        "the grant is gone from the hub (it expired, or the hub restarted). The change did not happen unless the web page shows it: check the target there",
      );
    if (found.state === "ended") return found;
    await sleep(POLL_MS);
  }

  throw new Error(
    `the grant did not end in 10 minutes. It can still wait on the hub: open the web page ${link} to approve or deny it, then check the target`,
  );
}

/** Turns the final grant into a result: the grant after a good run, or an error with the reason. */
function judge(final: MaintenanceGrant | undefined): MaintenanceGrant {
  if (!final) throw new Error("the hub gave no grant");
  const work = final.maintenance;
  if (work?.action === "uninstall" && final.retired) return final;
  if (work?.result === "done") return final;
  if (work?.result === "failed") throw new Error(work.detail && work.detail !== "" ? work.detail : "the run failed");
  if (final.state === "ended")
    throw new Error(`the grant ended with no change (${final.endReason ?? "no reason given"}). Nothing was changed`);
  throw new Error(`the hub gave no result for the grant: ${final.state ?? "unknown"}`);
}
