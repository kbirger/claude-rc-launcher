import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { asUser } from "./asuser";
import type { Identity } from "./asuser";
import type { Runner } from "./runner";

// The Claude Code skill that teaches a session how to ask for SSH access. A node deploys it into the skills folder of
// each user that its instances run as. The node usually runs as root and the skills folder belongs to a user with fewer
// rights, so the work is done as that user and never follows a symbolic link as root.

const FRONTMATTER = `---
name: ssh-access
description: Use this when a command must run on another machine, when a plain \`ssh\` to a machine fails with \`Permission denied (publickey)\`, or when the owner mentions SSH access to a machine from \`claude-rc ssh targets\`. This instance has no SSH key of its own and must not look for one. The skill explains how to ask the owner for temporary access.
---
`;

const BODY = `# SSH access to other machines

You have no SSH key. The owner gives you temporary access, one request at a time. The owner approves each request on a phone.

## Steps

1. Run \`claude-rc ssh targets\`. It lists the machines that you can ask for, as \`name  account@address\`. If it fails with \`SSH access is not turned on for this instance\`, stop. Tell the owner to turn on \`Allow SSH requests\` for this instance.
2. Ask for one target for the time that you need. The default is 60 minutes and the most is 480 minutes. Run \`claude-rc ssh request <target> --minutes <n> --reason "<why>"\`. The command waits for the owner for up to 10 minutes. Run it in the background with the run_in_background option of the Bash tool. Tell the owner in plain words that a request is waiting on the SSH access page. Read the output of the command when it ends. The command prints \`waiting for approval\` first. That line does not mean the owner answered. Wait for the line \`approved\`. After it, the output has a socket path, a config path and an \`ssh -F ...\` line. If the output ends with an error line instead, see Messages. The line \`access ends at <time>\` shows the end of the access in UTC. It can be missing.
3. Run the \`ssh -F <config> <target>\` line only after the output shows \`approved\`. On a Windows machine the line starts with the full path of \`ssh.exe\` in double quotes. Use that path exactly and never another \`ssh\` program. Add your remote command to the end, for example \`ssh -F <config> <target> 'uptime'\`. Use only that config file. Never add options that change the host key checks or the identity.
4. There is nothing to clean up. The access ends at the end time or when the owner revokes it. Do not leave connections, tunnels or ControlMaster sessions open.

## Rules

- Ask once for each target, with the shortest time that works. Never retry in a loop.
- If the owner denies the request or it times out, report this and stop.
- The access gives the full power of the account on the target. Run only the commands that the task of the owner needs. Prefer read-only commands. Say so before you change anything on the target.
- Never look for, copy or print keys. Never try other credentials or your own SSH keys.
- If ssh says that the access ended or the socket is gone, the grant is over. Ask again only if the owner agrees.

## Messages

| Message | What to do |
| --- | --- |
| \`approved\` | The owner approved. Run the \`ssh -F ...\` line that follows the socket and config paths. |
| \`SSH access is not turned on for this instance\` | Tell the owner to turn on \`Allow SSH requests\` for this instance. |
| \`no answer from the hub\` | The request timed out. The owner did not answer in 10 minutes. Report it and stop. |
| \`the unlock does not open the key\` | This is a problem on the side of the owner. Tell the owner. |
| \`the grant ended: denied\` | The owner denied the request. Report it and stop. Do not ask again. |
`;

const MARKER_PREFIX = "<!-- managed by claude-rc-launcher sha256:";

/** The text of the managed comment line for the given hash. */
function markerLine(hash: string): string {
  return `${MARKER_PREFIX}${hash} -->`;
}

/** The whole file: the frontmatter, the managed comment line with the hash of the rest, then the body. */
export function renderSkill(frontmatter: string = FRONTMATTER, body: string = BODY): string {
  const hash = createHash("sha256")
    .update(frontmatter + body)
    .digest("hex");

  return `${frontmatter}${markerLine(hash)}\n${body}`;
}

/** The skill text as the node deploys it. */
export const SSH_SKILL = renderSkill();

export type SkillResult = "written" | "unchanged" | "kept-foreign" | "failed";

/** An account that gets the skill: its name for the log, and the identity to run as (a uid and gid mean a switch from root). */
export type SkillUser = Identity & { name: string };

export interface SkillDeps {
  /** Runs the command as the user, for a node that switches users. */
  run: Runner;
  /** Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** One line for each failure and for a foreign file. Default: `console.error`. */
  log?: (line: string) => void;
  /** The file content. Default: the skill text. A test gives another text to simulate an update. */
  content?: string;
  /** Whether this process runs as root. Default: the uid is 0. */
  isRoot?: () => boolean;
}

const RUN_TIMEOUT_MS = 30_000;
/** The PATH of the script. The script runs as the user, but its tools never come from a folder of the user. */
const SCRIPT_PATH = "/usr/bin:/bin";
/** The managed line must follow the closing `---` of the frontmatter at once. */
const MANAGED_RE = /^---\n[\s\S]*?\n---\n(<!-- managed by claude-rc-launcher sha256:([0-9a-f]{64}) -->\n)/;
/** Files already reported in this process, by kind and home. */
const reported = new Set<string>();

type Verdict = "unchanged" | "update" | "foreign" | "edited";

/**
 * Decides what to do with the file that exists. A file is the launcher's own only when the managed line follows the
 * frontmatter. If the stored hash matches the rest of the file, it is unedited and an update replaces it.
 */
export function classify(existing: string, expected: string): Verdict {
  if (existing === expected) return "unchanged";
  const match = MANAGED_RE.exec(existing);
  if (!match) return "foreign";
  const line = match[1];
  const at = existing.indexOf(line);
  const rest = existing.slice(0, at) + existing.slice(at + line.length);
  const actual = createHash("sha256").update(rest).digest("hex");

  return actual === match[2] ? "update" : "edited";
}

/**
 * The script that runs as the target user. The home comes in `HOME` and the content on stdin: nothing is put into the
 * text of the script. It refuses a link at each part of the path. Mode `read` prints `absent`, or `present` and the file.
 * Mode `write` renames a temporary file over the target.
 */
const SCRIPT = String.raw`set -eu
umask 022
root="$HOME/.claude"
skills="$root/skills"
dir="$skills/ssh-access"
file="$dir/SKILL.md"
check() {
  for p in "$root" "$skills" "$dir" "$file"; do
    if [ -L "$p" ]; then echo "refused: $p is a symbolic link" >&2; exit 3; fi
  done
  if [ -e "$file" ] && [ ! -f "$file" ]; then echo "refused: $file is not a file" >&2; exit 3; fi
}
check
if [ "$1" = read ]; then
  if [ -e "$file" ]; then echo present; cat "$file"; else echo absent; fi
  exit 0
fi
new=$(cat; printf x)
for p in "$root" "$skills" "$dir"; do
  if [ ! -e "$p" ]; then mkdir "$p"; fi
  if [ ! -d "$p" ]; then echo "refused: $p is not a folder" >&2; exit 3; fi
done
check
tmp=$(mktemp "$dir/.SKILL.md.XXXXXX")
trap 'rm -f "$tmp"' EXIT
printf '%s' "${"$"}{new%x}" > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$file"
trap - EXIT
echo written
`;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

async function runScript(user: SkillUser, run: Runner, mode: "read" | "write", stdin?: string) {
  const command = asUser(user, "sh", ["-c", SCRIPT, "sh", mode]);
  const result = await run(command.cmd, command.args, {
    env: { ...command.env, PATH: SCRIPT_PATH },
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  if (result.code !== 0)
    throw new Error(result.timedOut ? "timed out" : firstLine(result.stderr) || `exit ${result.code}`);

  return result.stdout;
}

/** The node switches to the user: the script reads, TypeScript decides, the script writes. */
async function viaRunner(user: SkillUser, content: string, run: Runner): Promise<SkillResult | Verdict> {
  const output = await runScript(user, run, "read");
  const newline = output.indexOf("\n");
  const status = newline < 0 ? output.trim() : output.slice(0, newline);

  if (status === "present") {
    const verdict = classify(output.slice(newline + 1), content);
    if (verdict !== "update") return verdict;
  } else if (status !== "absent") {
    throw new Error(`unexpected answer: ${firstLine(output)}`);
  }

  const answer = (await runScript(user, run, "write", content)).trim().split("\n").pop();
  if (answer === "written") return "written";
  throw new Error(`unexpected answer: ${answer ?? ""}`);
}

/** Makes `path` a real folder: an existing link or file is refused. */
async function ensureFolder(path: string): Promise<void> {
  let info = await lstat(path).catch((caught: unknown) => {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  });

  if (!info) {
    await mkdir(path, { mode: 0o755 });
    info = await lstat(path);
  }

  if (info.isSymbolicLink()) throw new Error(`refused: ${path} is a symbolic link`);
  if (!info.isDirectory()) throw new Error(`refused: ${path} is not a folder`);
}

/** The node runs as the user itself: plain Node calls, with a check for a link at each part of the path. */
async function direct(home: string, content: string): Promise<SkillResult | Verdict> {
  const root = join(home, ".claude");
  const skills = join(root, "skills");
  const dir = join(skills, "ssh-access");
  const file = join(dir, "SKILL.md");

  const info = await lstat(file).catch((caught: unknown) => {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  });

  // The parents are checked first, also when the file exists.
  for (const folder of [root, skills, dir]) {
    const parent = await lstat(folder).catch(() => undefined);
    if (parent?.isSymbolicLink()) throw new Error(`refused: ${folder} is a symbolic link`);
  }

  if (info) {
    if (info.isSymbolicLink()) throw new Error(`refused: ${file} is a symbolic link`);
    if (!info.isFile()) throw new Error(`refused: ${file} is not a file`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const old = await handle.readFile("utf8").finally(() => handle.close());
    const verdict = classify(old, content);
    if (verdict !== "update") return verdict;
  }

  for (const folder of [root, skills, dir]) await ensureFolder(folder);
  const temporary = join(dir, `.SKILL.md.${randomBytes(6).toString("hex")}`);

  try {
    const handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(content).finally(() => handle.close());
    await chmod(temporary, 0o644);
    await rename(temporary, file);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => {});
    throw caught;
  }

  return "written";
}

/**
 * Puts the skill into `<home>/.claude/skills/ssh-access/SKILL.md` of the user. A file that the launcher did not make,
 * or that somebody edited, stays as it is. It never throws: a failure is one log line and the result `failed`.
 */
export async function ensureSkill(user: SkillUser, deps: SkillDeps): Promise<SkillResult> {
  const log =
    deps.log ??
    ((line: string) => {
      console.error(line);
    });
  const content = deps.content ?? SSH_SKILL;
  const isRoot = deps.isRoot ?? (() => process.getuid?.() === 0);

  try {
    if (!isAbsolute(user.home)) throw new Error(`the home ${user.home} is not an absolute path`);
    const switching = user.uid !== undefined && user.gid !== undefined;
    // A root node that has no uid to switch to must never write by path: the folders belong to the user.
    if (!switching && isRoot()) throw new Error("the node runs as root and has no user to switch to");
    const result = switching ? await viaRunner(user, content, deps.run) : await direct(user.home, content);
    const where = `${user.home}/.claude/skills/ssh-access/SKILL.md`;

    if ((result === "foreign" || result === "edited") && !reported.has(`${result}:${user.home}`)) {
      reported.add(`${result}:${user.home}`);
      log(
        result === "foreign"
          ? `ssh skill for ${user.name}: ${where} is not managed by the launcher, left as it is`
          : `ssh skill for ${user.name}: ${where} was edited, left as it is; delete it to get the new version`,
      );
    }

    return result === "foreign" || result === "edited" ? "kept-foreign" : result === "update" ? "written" : result;
  } catch (error) {
    log(
      `ssh skill for ${user.name}: cannot install: ${error instanceof Error ? error.message : String(error)}; will retry at the next instance change`,
    );

    return "failed";
  }
}

/** The SHA-256 of the whole skill text: a change of the skill changes it. */
export function skillVersion(content: string = SSH_SKILL): string {
  return createHash("sha256").update(content).digest("hex");
}
