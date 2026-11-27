import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { markShadowed } from "./permrules";
import { MANAGED_PATH_LINUX, SettingsFile } from "./SettingsFile";
import type { LayerScope, PermissionLayers } from "./SettingsFile";

type GitRoot = { root: string } | { reason: string };

/**
 * The git root of a session folder: the nearest folder above (or at) `root` that has a `.git` directory. The walk stops at
 * the home folder (a repository rooted there is not used) and at the file system root. A `.git` file is a work tree.
 */
async function findGitRoot(root: string, home: string, ownerUid?: number): Promise<GitRoot> {
  let dir = root;

  for (;;) {
    if (dir === home) return { reason: "no git repository below the home folder" };
    let self;

    try {
      self = await lstat(dir);
    } catch {
      return { reason: "the session folder cannot be read" };
    }

    if (self.isSymbolicLink()) return { reason: "a folder on the way to the git root is a symlink" };
    let git;

    try {
      git = await lstat(join(dir, ".git"));
    } catch {
      git = undefined;
    }

    if (git) {
      if (git.isFile()) return { reason: "this is a git work tree" };
      if (git.isSymbolicLink()) return { reason: "the .git entry is a symlink" };

      if (git.isDirectory()) {
        if (ownerUid !== undefined && (git.uid !== ownerUid || self.uid !== ownerUid))
          return { reason: "the git root is owned by another user" };
        return { root: dir };
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return { reason: "no git repository found" };
    dir = parent;
  }
}

export class ClaudeSettings {
  private constructor(
    /** Highest precedence first. */
    readonly files: readonly SettingsFile[],
  ) {}

  /** The user file of one home folder. */
  static forHome(options: { home: string; ownerUid?: number; isRoot?: () => boolean }): ClaudeSettings {
    return new ClaudeSettings([
      new SettingsFile("user", join(options.home, ".claude", "settings.json"), {
        ownerUid: options.ownerUid,
        ...(options.isRoot ? { isRoot: options.isRoot } : {}),
      }),
    ]);
  }

  /** The file of one scope, if this set has one. */
  file(scope: LayerScope): SettingsFile | undefined {
    return this.files.find((settingsFile) => settingsFile.scope === scope);
  }

  /**
   * All the files that apply to a session. `root` is the checked real root of the session folder (Session.open).
   * `managedPath` replaces the Linux managed file path (tests).
   */
  static async forSession(options: {
    home: string;
    root: string;
    ownerUid?: number;
    isRoot?: () => boolean;
    platform?: NodeJS.Platform;
    managedPath?: string;
  }): Promise<ClaudeSettings> {
    const { home, root, ownerUid } = options;
    const platform = options.platform ?? process.platform;
    const found = await findGitRoot(root, home, ownerUid);
    const files: SettingsFile[] = [];
    const own = { ownerUid, ...(options.isRoot ? { isRoot: options.isRoot } : {}) };
    if (platform === "linux") files.push(new SettingsFile("managed", options.managedPath ?? MANAGED_PATH_LINUX, {}));
    files.push(
      "root" in found
        ? new SettingsFile("local", join(found.root, ".claude", "settings.local.json"), own)
        : new SettingsFile("local", null, { unknownReason: found.reason }),
    );
    // The file in the session folder is also read when it is not the same file as the local file.
    if (!("root" in found) || found.root !== root)
      files.push(new SettingsFile("legacy-local", join(root, ".claude", "settings.local.json"), own));
    files.push(new SettingsFile("project", join(root, ".claude", "settings.json"), own));
    files.push(new SettingsFile("user", join(home, ".claude", "settings.json"), own));
    return new ClaudeSettings(files);
  }

  /** Reads every file, then marks the allow rules that a deny or ask rule overrides. */
  async layers(): Promise<PermissionLayers> {
    const layers = await Promise.all(this.files.map((settingsFile) => settingsFile.read()));
    const marked = markShadowed(layers.map((layer) => ({ scope: layer.scope, rules: layer.rules })));
    for (const layer of layers) layer.rules = marked.filter((markedRule) => markedRule.scope === layer.scope);
    return { layers };
  }
}
