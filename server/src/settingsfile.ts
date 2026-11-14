/*
 * The Claude Code settings files that hold permission rules. See docs/superpowers/specs/2026-11-14-permissions-design.md.
 *
 * SettingsFile is one file. ClaudeSettings is the set of files that apply to one home folder or to one session.
 * A user controls the files and the folders around them, so every read goes through
 * readUserFile (no hard link, no FIFO, size cap). It follows a symlink to the real file and requires the real file to be
 * owned by the instance user, so a link cannot name another user's file.
 *
 * Where Claude Code keeps the files (https://code.claude.com/docs/en/settings):
 *   user          <home>/.claude/settings.json
 *   project       <session folder>/.claude/settings.json (shared, committed)
 *   local         <git root>/.claude/settings.local.json (since Claude Code 2.1.211)
 *   legacy-local  <session folder>/.claude/settings.local.json (older versions wrote it there, newer ones still read it)
 *   managed       /etc/claude-code/managed-settings.json on Linux (read-only)
 * The layers are listed with the highest precedence first: managed, local, legacy-local, project, user.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { markShadowed, parseRule, rulesOf, withRule, withoutRule, type MarkedRule, type RuleList } from "./permrules";
import { FileConflict, FileRefused, readUserFile, writeUserFile } from "./safefile";

export type LayerScope = "user" | "project" | "local" | "legacy-local" | "managed";

export type Layer = {
  scope: LayerScope;
  /** Null when the node cannot tell where Claude Code puts the file. */
  path: string | null;
  /** True for user, project and local when the path is known. False for managed and legacy-local. */
  writable: boolean;
  state: "ok" | "missing" | "invalid" | "unknown-path";
  /** For `invalid` and `unknown-path`. */
  reason?: string;
  /** SHA-256 of the file as read (state `ok`). A writer uses it to find out that the file changed. */
  hash?: string;
  /** The file that was really read, when it is not at `path` (a symlink in the name or in a folder). */
  resolvedPath?: string;
  rules: MarkedRule[];
  warnings: string[];
};

export type PermissionLayers = { layers: Layer[] };

export const MANAGED_PATH_LINUX = "/etc/claude-code/managed-settings.json";

/** A failed edit. `status` is the HTTP status that a route maps it to. */
export class SettingsError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const WRITABLE_SCOPES: readonly LayerScope[] = ["user", "project", "local"];
const MAX_RULE_CHARS = 2000;
const RULE_LISTS: readonly string[] = ["allow", "ask", "deny"];

function checkRule(list: string, raw: unknown): asserts raw is string {
  if (!RULE_LISTS.includes(list)) throw new SettingsError(400, "the list must be allow, ask or deny");
  if (typeof raw !== "string" || raw.length === 0) throw new SettingsError(400, "the rule is empty");
  if (raw.length > MAX_RULE_CHARS) throw new SettingsError(400, `the rule is longer than ${MAX_RULE_CHARS} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) throw new SettingsError(400, "the rule has a control character");
  if (!parseRule(raw)) throw new SettingsError(400, "the rule is malformed: use Tool or Tool(specifier)");
}

export class SettingsFile {
  constructor(
    readonly scope: LayerScope,
    readonly path: string | null,
    private readonly opts: {
      unknownReason?: string;
      ownerUid?: number;
      /** Tests: replace the root check, the chown and the handle-path lookup of the folder step. */
      isRoot?: () => boolean;
      chown?: (fh: FileHandle, uid: number, gid: number) => Promise<void>;
      verifyPath?: (fh: FileHandle) => Promise<string>;
    } = {},
  ) {}

  private get writable(): boolean {
    return this.path !== null && WRITABLE_SCOPES.includes(this.scope);
  }

  private layer(state: Layer["state"], extra: Partial<Layer> = {}): Layer {
    return { scope: this.scope, path: this.path, writable: this.writable, state, rules: [], warnings: [], ...extra };
  }

  /** Never throws. A bad file gives state `invalid` with a reason. */
  async read(): Promise<Layer> {
    const path = this.path;
    if (path === null) return this.layer("unknown-path", { reason: this.opts.unknownReason ?? "the path is not known" });
    // Symlinks are followed (a settings file kept in a dotfiles repo is common). The real file must belong to the instance user.
    const r = await readUserFile(path, { follow: true, ...(this.opts.ownerUid !== undefined ? { ownerUid: this.opts.ownerUid } : {}) });
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
    return this.layer("ok", { hash: r.hash, ...(r.realPath !== undefined && r.realPath !== path ? { resolvedPath: r.realPath } : {}), warnings, rules: rules.map((rule) => ({ ...rule, scope: this.scope })) });
  }

  async addRule(o: { list: RuleList; raw: string; expectedHash: string | null }): Promise<Layer> {
    checkRule(o.list, o.raw);
    return this.edit(o.expectedHash, (text) => withRule(text, o.list, o.raw));
  }

  async removeRule(o: { list: RuleList; raw: string; expectedHash: string }): Promise<Layer> {
    checkRule(o.list, o.raw);
    return this.edit(o.expectedHash, (text) => {
      if (text === null) throw new SettingsError(404, "the file does not exist");
      const r = withoutRule(text, o.list, o.raw);
      if (!r.changed) throw new SettingsError(404, "the rule is not in the file");
      return r;
    });
  }

  /**
   * Makes the `.claude` folder of a new file, one level only. The parent must be a real folder (lstat: not a symlink) of the
   * instance user. The new folder is opened with O_DIRECTORY|O_NOFOLLOW and checked through the handle: a folder, made by
   * this process, at the expected place (/proc/self/fd on Linux). Only then does a root node chown it, through the handle,
   * so a path that the user swaps for a symlink in between is never followed. Anything wrong gives 403. Nothing that this
   * function did not create is removed or changed. A parent that is swapped after its check is a gap that we accept.
   */
  private async makeFolder(dir: string): Promise<void> {
    if (await lstat(dir).then(() => true, () => false)) return; // the write checks an existing entry (a symlink is refused)
    const parent = await lstat(dirname(dir)).catch(() => null);
    if (!parent || !parent.isDirectory()) throw new SettingsError(403, "its folder is not a real folder");
    if (this.opts.ownerUid !== undefined && parent.uid !== this.opts.ownerUid) throw new SettingsError(403, "its folder is owned by another user");
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch {
      throw new SettingsError(403, "its folder cannot be made");
    }
    let fh: FileHandle | undefined;
    try {
      fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const st = await fh.stat();
      if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error("not the folder that was made");
      if (process.platform === "linux") {
        const expected = join(await realpath(dirname(dir)), basename(dir));
        const opened = await (this.opts.verifyPath ?? ((h: FileHandle) => readlink(`/proc/self/fd/${h.fd}`)))(fh);
        if (opened !== expected) throw new Error("not at the expected place");
      }
      const isRoot = this.opts.isRoot ?? (() => process.getuid?.() === 0);
      if (isRoot() && this.opts.ownerUid !== undefined) {
        await (this.opts.chown ?? ((h, uid, gid) => h.chown(uid, gid)))(fh, this.opts.ownerUid, parent.gid);
      }
    } catch {
      throw new SettingsError(403, "its folder is not safe to use");
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  /**
   * Reads the file, applies `change` to its text and writes the result to the real file behind the path (a symlink stays).
   * `expectedHash` is what the caller saw. It is checked here for a clear error and again inside the write, which is
   * the check that cannot race. Returns the layer read back after the write.
   */
  private async edit(expectedHash: string | null, change: (text: string | null) => { text: string; changed: boolean }): Promise<Layer> {
    const path = this.path;
    if (path === null) throw new SettingsError(403, this.opts.unknownReason ?? "the path is not known");
    if (!this.writable) throw new SettingsError(403, `the ${this.scope} settings file is read-only`);
    const ownerOpt = this.opts.ownerUid !== undefined ? { ownerUid: this.opts.ownerUid } : {};
    const r = await readUserFile(path, { follow: true, ...ownerOpt });
    if (r.kind === "invalid") throw new SettingsError(422, `the file cannot be edited: ${r.reason}`);
    let text: string | null = null;
    if (r.kind === "ok") {
      text = r.bytes.toString("utf8");
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new SettingsError(422, "the file cannot be edited: it is not valid JSON");
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new SettingsError(422, "the file cannot be edited: it is not a JSON object");
    }
    if ((r.kind === "ok" ? r.hash : null) !== expectedHash) throw new SettingsError(409, "the file changed since it was read");
    let next: { text: string; changed: boolean };
    try {
      next = change(text);
    } catch (e) {
      if (e instanceof SettingsError) throw e;
      throw new SettingsError(422, `the file cannot be edited: ${(e as Error).message}`);
    }
    if (!next.changed) return this.read();
    const target = r.kind === "ok" && r.realPath !== undefined ? r.realPath : path;
    // A new file may need its `.claude` folder (one level only, never a path). As root the folder goes to the instance user.
    if (r.kind === "missing") await this.makeFolder(dirname(target));
    // A new file gets the group of its folder. The folder is the instance user's (the write checks that).
    let gid: number | undefined;
    try {
      gid = (await lstat(dirname(target))).gid;
    } catch {
      gid = undefined;
    }
    try {
      await writeUserFile(target, Buffer.from(next.text, "utf8"), { ...ownerOpt, ...(gid !== undefined ? { gid } : {}), expectedHash, follow: true });
    } catch (e) {
      if (e instanceof FileConflict) throw new SettingsError(409, "the file changed since it was read");
      if (e instanceof FileRefused) throw new SettingsError(403, e.reason);
      throw e;
    }
    return this.read();
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

  /** The file of one scope, if this set has one. */
  file(scope: LayerScope): SettingsFile | undefined {
    return this.files.find((f) => f.scope === scope);
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
    if (platform === "linux") files.push(new SettingsFile("managed", o.managedPath ?? MANAGED_PATH_LINUX, {}));
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
