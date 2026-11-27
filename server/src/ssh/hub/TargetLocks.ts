import { TargetError } from "../TargetStore";
import { MAINTENANCE_BUSY } from "./SshService";

/** Which lock of a target: `edit` for a change, `retire` for a delete. */
export type TargetLockKind = "edit" | "retire";

/** The source of the maintenance lock: the grant of a target whose maintenance is pending, active or still running. */
export interface MaintenanceLookup {
  maintenanceFor(targetId: string): unknown;
}

/**
 * The per-target locks of the requests that change a target. `edit` is held by PATCH, by the key routes, by the
 * provisioner key routes and by the approve of a `sources` or `install` grant, `retire` by DELETE and by the approve
 * of an `uninstall` grant. A lock is taken synchronously, before the first await of the work, and lasts for one
 * request. While a maintenance grant of the target is pending, active or still running, `maintenanceFor` is the lock:
 * it clears by itself on a deny, an expiry, the end of the run and a restart of the hub.
 */
export class TargetLocks {
  private readonly editing = new Set<string>();
  private readonly retiring = new Set<string>();

  constructor(private readonly maintenance: MaintenanceLookup) {}

  /** True while a retire of the target runs. */
  isRetiring(id: string): boolean {
    return this.retiring.has(id);
  }

  /** 409 when a retire, another change or a maintenance grant of the target runs. */
  needIdle(id: string): void {
    if (this.retiring.has(id)) throw new TargetError(409, "this target is being retired");
    if (this.editing.has(id)) throw new TargetError(409, "this target is being changed");
    if (this.maintenance.maintenanceFor(id)) throw new TargetError(409, MAINTENANCE_BUSY);
  }

  /** Runs `work` under a lock of the target: 409 when it is not idle, and the lock is always freed. */
  async run<T>(kind: TargetLockKind, id: string, work: () => Promise<T>): Promise<T> {
    this.needIdle(id);
    return await this.under(kind, id, work);
  }

  /**
   * Runs `work` under a lock for the approve of a maintenance grant. The grant itself is the maintenance lock, so only
   * the locks of one request are checked. Nobody else takes the lock while the grant waits.
   */
  async hold<T>(kind: TargetLockKind, id: string, work: () => Promise<T>): Promise<T> {
    // The DELETE that made an uninstall grant still holds its lock for a moment after the push to the phone.
    if (this.retiring.has(id) || this.editing.has(id))
      throw new TargetError(409, "the request is still being set up or another change runs: try again in a moment");
    return await this.under(kind, id, work);
  }

  private async under<T>(kind: TargetLockKind, id: string, work: () => Promise<T>): Promise<T> {
    const set = kind === "retire" ? this.retiring : this.editing;
    set.add(id);

    try {
      return await work();
    } finally {
      set.delete(id);
    }
  }
}
