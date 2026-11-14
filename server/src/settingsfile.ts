/*
 * The Claude Code settings files that hold permission rules. See docs/superpowers/specs/2026-11-14-permissions-design.md.
 *
 * SettingsFile is one file. ClaudeSettings is the set of files that apply to one home folder or to one session.
 * This file only READS in Phase 1. A user controls the files and the folders around them, so every read goes through
 * readUserFile (no symlink, no hard link, no FIFO, size cap) and the parent folder is checked too.
 *
 * Where Claude Code keeps the files (https://code.claude.com/docs/en/settings):
 *   user          <home>/.claude/settings.json
 *   project       <session folder>/.claude/settings.json (shared, committed)
 *   local         <git root>/.claude/settings.local.json (since Claude Code 2.1.211)
 *   legacy-local  <session folder>/.claude/settings.local.json (older versions wrote it there, newer ones still read it)
 *   managed       /etc/claude-code/managed-settings.json on Linux (read-only)
 * The layers are listed with the highest precedence first: managed, local, legacy-local, project, user.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { markShadowed, rulesOf, type MarkedRule } from "./permrules";
import { readUserFile } from "./safefile";

export type LayerScope = "user" | "project" | "local" | "legacy-local" | "managed";

export type Layer = {
  scope: LayerScope;
  /** Null when the node cannot tell where Claude Code puts the file. */
  path: string | null;
  /** False for every layer in Phase 1. */
  writable: boolean;
  state: "ok" | "missing" | "invalid" | "unknown-path";
  /** For `invalid` and `unknown-path`. */
  reason?: string;
  /** SHA-256 of the file as read (state `ok`). A writer uses it to find out that the file changed. */
  hash?: string;
  rules: MarkedRule[];
  warnings: string[];
};

export type PermissionLayers = { layers: Layer[] };

export const MANAGED_PATH_LINUX = "/etc/claude-code/managed-settings.json";

export class SettingsFile {
  constructor(
    readonly scope: LayerScope,
    readonly path: string | null,
    private readonly opts: { writable?: boolean; unknownReason?: string; ownerUid?: number } = {},
  ) {}

  private layer(state: Layer["state"], extra: Partial<Layer> = {}): Layer {
    return { scope: this.scope, path: this.path, writable: this.opts.writable ?? false, state, rules: [], warnings: [], ...extra };
  }

  /** Never throws. A bad file gives state `invalid` with a reason. */
  async read(): Promise<Layer> {
    const path = this.path;
    if (path === null) return this.layer("unknown-path", { reason: this.opts.unknownReason ?? "the path is not known" });
    const parent = dirname(path);
    try {
      if ((await lstat(parent)).isSymbolicLink()) return this.layer("invalid", { reason: `the ${basename(parent)} folder is a symlink` });
    } catch {
      // A missing parent folder means a missing file. Another error shows up in the read below.
    }
    if (this.opts.ownerUid !== undefined) {
      try {
        if ((await lstat(path)).uid !== this.opts.ownerUid) return this.layer("invalid", { reason: "owned by another user" });
      } catch {
        // Missing: reported by the read below.
      }
    }
    // The real place of the file, worked out now. readUserFile makes sure that the opened handle is really there, so a folder
    // that the user swaps for a symlink after the checks above gives `invalid` and not another file.
    let expectedPath: string | undefined;
    try {
      expectedPath = join(await realpath(parent), basename(path));
    } catch {
      expectedPath = undefined; // The folder is gone: the read below says missing.
    }
    const r = await readUserFile(path, expectedPath === undefined ? {} : { expectedPath });
    if (r.kind === "missing") return this.layer("missing");
    if (r.kind === "invalid") return this.layer("invalid", { reason: r.reason });
    let doc: unknown;
    try {
      doc = JSON.parse(r.bytes.toString("utf8"));
    } catch {
      return this.layer("invalid", { reason: "it is not valid JSON" });
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return this.layer("invalid", { reason: "it is not a JSON object" });
    const { rules, warnings } = rulesOf(doc as Record<string, unknown>);
    return this.layer("ok", { hash: r.hash, warnings, rules: rules.map((rule) => ({ ...rule, scope: this.scope })) });
  }
}

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
        if (ownerUid !== undefined && (git.uid !== ownerUid || self.uid !== ownerUid)) return { reason: "the git root is owned by another user" };
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
  static forHome(o: { home: string; ownerUid?: number }): ClaudeSettings {
    return new ClaudeSettings([new SettingsFile("user", join(o.home, ".claude", "settings.json"), { ownerUid: o.ownerUid })]);
  }

  /**
   * All the files that apply to a session. `root` is the checked real root of the session folder (Session.open).
   * `managedPath` replaces the Linux managed file path (tests).
   */
  static async forSession(o: { home: string; root: string; ownerUid?: number; platform?: NodeJS.Platform; managedPath?: string }): Promise<ClaudeSettings> {
    const { home, root, ownerUid } = o;
    const platform = o.platform ?? process.platform;
    const found = await findGitRoot(root, home, ownerUid);
    const files: SettingsFile[] = [];
    if (platform === "linux") files.push(new SettingsFile("managed", o.managedPath ?? MANAGED_PATH_LINUX, { writable: false }));
    files.push(
      "root" in found
        ? new SettingsFile("local", join(found.root, ".claude", "settings.local.json"), { ownerUid })
        : new SettingsFile("local", null, { unknownReason: found.reason }),
    );
    // The file in the session folder is also read when it is not the same file as the local file.
    if (!("root" in found) || found.root !== root) files.push(new SettingsFile("legacy-local", join(root, ".claude", "settings.local.json"), { ownerUid }));
    files.push(new SettingsFile("project", join(root, ".claude", "settings.json"), { ownerUid }));
    files.push(new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid }));
    return new ClaudeSettings(files);
  }

  /** Reads every file, then marks the allow rules that a deny or ask rule overrides. */
  async layers(): Promise<PermissionLayers> {
    const layers = await Promise.all(this.files.map((f) => f.read()));
    const marked = markShadowed(layers.map((l) => ({ scope: l.scope, rules: l.rules })));
    for (const l of layers) l.rules = marked.filter((m) => m.scope === l.scope);
    return { layers };
  }
}
