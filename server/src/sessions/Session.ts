import { blockedIn } from "./blocked";
import type { BlockedCall } from "./blocked";
import type { ClaudeSettings } from "./ClaudeSettings";
import type { InstanceSessions } from "./InstanceSessions";
import { PinnedRoot } from "./PinnedRoot";
import type { Found } from "./scan";
import type { PermissionLayers } from "./SettingsFile";
import { touchedIn } from "./touched";
import type { TouchedFile } from "./touched";

export class Session {
  readonly id: string;
  /** The lexical first cwd. */
  readonly root: string;
  readonly worktree: boolean;
  /** The transcript that find read. */
  readonly file: string;
  readonly branch?: string;
  readonly startedAt?: string;

  /** No I/O here. */
  constructor(
    readonly instance: InstanceSessions,
    found: Found,
  ) {
    this.id = found.id;
    this.root = found.root;
    this.worktree = found.worktree;
    this.file = found.file;
    this.branch = found.branch;
    this.startedAt = found.startedAt;
  }

  /** The files this session touched. It reads this transcript and never scans again. */
  touched(options: { dirs: readonly string[] }): Promise<TouchedFile[]> {
    const catalog = this.instance.catalog;
    return touchedIn({
      fs: catalog.fs,
      file: this.file,
      root: this.root,
      platform: catalog.platform,
      dirs: options.dirs,
    });
  }

  /** The blocked tool calls of this transcript, newest first. It reads this transcript and never scans again. */
  blocked(): Promise<BlockedCall[]> {
    return blockedIn({ fs: this.instance.catalog.fs, file: this.file });
  }

  /** The settings layers that apply to this session. It runs the real-root check first (a failed check is a 404). */
  async permissions(options: { ownerUid?: number; isRoot?: () => boolean }): Promise<PermissionLayers> {
    return (await this.open()).permissions(options);
  }

  /** The settings files that apply to this session. It runs the real-root check first (a failed check is a 404). */
  async settings(options: { ownerUid?: number; isRoot?: () => boolean }): Promise<ClaudeSettings> {
    return (await this.open()).settings(options);
  }

  /** Runs the real-root check and gives the checked root. A failed check is a 404. */
  open(): Promise<PinnedRoot> {
    return PinnedRoot.pin(this);
  }
}
