import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { asUser } from "./asuser";
import type { Identity } from "./asuser";
import type { Runner } from "./runner";

// The Claude Code skill that teaches a session how to ask for SSH access. A node deploys it into the skills folder of
// each user that its instances run as. The node usually runs as root and the skills folder belongs to a user with fewer
// rights, so the work is done as that user and never follows a symbolic link as root.

const FRONTMATTER = `---
name: ssh-access
description: Use this when you need to run a command on another machine over SSH from this instance, for example a machine that \`claude-rc ssh targets\` lists. It explains how to ask the owner for temporary access and how to use it.
---
`;

const BODY = `# SSH access to other machines

You have no SSH key. The owner gives you temporary access, one request at a time. The owner approves each request on a phone.

## Steps

1. Run \`claude-rc ssh targets\`. It lists the machines that you can ask for, as \`name  account@address\`. If it fails with \`SSH access is not turned on for this instance\`, stop. Tell the owner to turn on \`Allow SSH requests\` for this instance.
2. Ask for one target for the time that you need. The default is 60 minutes and the most is 480 minutes. Run \`claude-rc ssh request <target> --minutes <n> --reason "<why>"\`. The command waits for the owner for up to 10 minutes. Run it in the background with the run_in_background option of the Bash tool. Tell the owner in plain words that a request is waiting on the SSH access page. Read the output of the command when it ends.
3. The command prints a socket path, a config file path and a line \`ssh -F <config> <target>\`. Run that line with your remote command added, for example \`ssh -F <config> <target> 'uptime'\`. Use only that config file. Never add options that change the host key checks or the identity.
4. There is nothing to clean up. The access ends at the end time or when the owner revokes it. Do not leave connections, tunnels or ControlMaster sessions open.

## Rules

- Ask once for each target, with the shortest time that works. Never retry in a loop.
- If the owner denies the request or it times out, report this and stop.
- The access gives the full power of the account on the target. Run only the commands that the task of the owner needs. Prefer read-only commands. Say so before you change anything on the target.
- Never look for, copy or print keys. Never try other credentials or the own SSH keys of the user.
- If ssh says that the access ended or the socket is gone, the grant is over. Ask again only if the owner agrees.

## Messages

| Message | What to do |
| --- | --- |
| \`SSH access is not turned on for this instance\` | Tell the owner to turn on \`Allow SSH requests\` for this instance. |
| \`no answer from the hub\` | This is a problem on the side of the owner. Tell the owner. |
| \`the unlock does not open the key\` | This is a problem on the side of the owner. Tell the owner. |
| The request is denied | Report it and stop. Do not ask again. |
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
}

const RUN_TIMEOUT_MS = 30_000;
const MANAGED_RE = /^<!-- managed by claude-rc-launcher sha256:/m;
/** Foreign files already reported in this process. */
const reported = new Set<string>();

/**
 * The script that runs as the target user. The content comes on stdin and the home in `HOME`: nothing is put into
 * the text of the script. It refuses a link at each part of the path and renames a temporary file over the target.
 */
const SCRIPT = String.raw`set -eu
umask 022
root="$HOME/.claude"
skills="$root/skills"
dir="$skills/ssh-access"
file="$dir/SKILL.md"
new=$(cat; printf x)
check() {
  for p in "$root" "$skills" "$dir" "$file"; do
    if [ -L "$p" ]; then echo "refused: $p is a symbolic link" >&2; exit 3; fi
  done
}
check
if [ -e "$file" ]; then
  if [ ! -f "$file" ]; then echo "refused: $file is not a file" >&2; exit 3; fi
  old=$(cat "$file"; printf x)
  if [ "$old" = "$new" ]; then echo unchanged; exit 0; fi
  if ! grep -q '^<!-- managed by claude-rc-launcher sha256:' "$file"; then echo kept-foreign; exit 0; fi
fi
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

async function viaRunner(user: SkillUser, content: string, run: Runner): Promise<SkillResult> {
  const command = asUser(user, "sh", ["-c", SCRIPT]);
  const result = await run(command.cmd, command.args, { env: command.env, stdin: content, timeoutMs: RUN_TIMEOUT_MS });
  if (result.code !== 0)
    throw new Error(result.timedOut ? "timed out" : firstLine(result.stderr) || `exit ${result.code}`);
  const answer = result.stdout.trim().split("\n").pop();
  if (answer === "written" || answer === "unchanged" || answer === "kept-foreign") return answer;
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
async function direct(home: string, content: string): Promise<SkillResult> {
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
    if (old === content) return "unchanged";
    if (!MANAGED_RE.test(old)) return "kept-foreign";
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
 * Puts the skill into `<home>/.claude/skills/ssh-access/SKILL.md` of the user. A file without the managed comment line
 * is not ours and stays as it is. It never throws: a failure is one log line and the result `failed`.
 */
export async function ensureSkill(user: SkillUser, deps: SkillDeps): Promise<SkillResult> {
  if ((deps.platform ?? process.platform) === "win32") return "unchanged";
  const log =
    deps.log ??
    ((line: string) => {
      console.error(line);
    });
  const content = deps.content ?? SSH_SKILL;

  try {
    // A uid and gid mean that the node switches to the user. Without them the node is the user.
    const result =
      user.uid !== undefined && user.gid !== undefined
        ? await viaRunner(user, content, deps.run)
        : await direct(user.home, content);

    if (result === "kept-foreign" && !reported.has(user.home)) {
      reported.add(user.home);
      log(
        `ssh skill for ${user.name}: ${user.home}/.claude/skills/ssh-access/SKILL.md is not managed by the launcher, left as it is`,
      );
    }

    return result;
  } catch (error) {
    log(`ssh skill for ${user.name}: cannot install: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/** The SHA-256 of the whole skill text: a change of the skill changes it. */
export function skillVersion(content: string = SSH_SKILL): string {
  return createHash("sha256").update(content).digest("hex");
}
