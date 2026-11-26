import { HOST_ID_RE } from "./hostid";
import { AWK_PROGRAM, LOCK_LINES, shQuote } from "./sshprovision";
import type { Script } from "./sshprovision";
import { ADDRESS_RE, SCRIPT_PATH_RE } from "./sshtargets";

// The provisioner key of an external target. The pure part: the grammar of the commands that the script on the target
// takes, the parse of its answers, the line that goes into `authorized_keys`, and the text of the Linux scripts.
//
// The script is trusted code on a machine that holds a real account. The grammar is small on purpose. The value of
// `SSH_ORIGINAL_COMMAND` must match one form exactly. A list in `sources` holds exact IP addresses or host names, with
// no wildcard, no range and no quote (a ruling of the owner, stricter than `from=` of OpenSSH). The rule for one
// element is `ADDRESS_RE` of `sshtargets.ts`. The shared vectors in `sshprovisioner.vectors.json` keep the hub and
// the script equal.

// Texts of the hub that the CLI matches. One definition keeps both sides equal.
/** 409 of `POST /targets/:id/provisioner-key` and of `GET /targets/:id/provisioner-install` (key missing). */
export const NO_PROVISIONER_KEY_TEXT = "the target has no provisioner key";
export const HAS_PROVISIONER_KEY_TEXT = "the target has a provisioner key already";
/** 409 of a PATCH of nodes that allows none of the addresses that work now. The CLI asks for `--yes`. */
export const CONFIRM_NODES_TEXT = "the new list allows none of the addresses that work now";
export const CONFIRM_NODES_SUFFIX = ": send it again with confirm";

/** Tests only: the kind of forced bad edit that `linuxScript` can build in. */
export type GuardTest = true | "main" | "other";

export type ProvisionerCommand = { kind: "on" | "off" | "status" | "uninstall" } | { kind: "sources"; list: string[] };

export type ProvisionerAnswer =
  | { kind: "on" | "sources"; list: string[] }
  | { kind: "off" | "uninstall" }
  | { kind: "status"; present: boolean; list: string[] }
  | { kind: "installed"; path: string };

/** The most elements in a list. This is the node limit of the hub. */
export const MAX_SOURCES = 200;
/** The most bytes in the whole value of `SSH_ORIGINAL_COMMAND`. */
export const MAX_COMMAND_BYTES = 4096;
/** The most characters in one element. */
export const MAX_ELEMENT = 255;

// The pattern for a script path lives in `sshtargets.ts` (the target store uses it too), so the two modules do not import each other.
export { SCRIPT_PATH_RE };
const SCRIPT_PATH_CLASS = "A-Za-z0-9._/+:@=-";

const BASE64 = "[A-Za-z0-9+/]{16,2048}={0,2}";
const MAIN_LINE_RE = new RegExp(`^ssh-ed25519 (${BASE64}) (claude-rc:([^ ]+))$`);
const PROVISIONER_LINE_RE = new RegExp(`^ssh-ed25519 (${BASE64}) (claude-rc-provisioner:([^ ]+))$`);
const BLOB_RE = new RegExp(`^${BASE64}$`);

function validElement(element: string): boolean {
  return element.length <= MAX_ELEMENT && ADDRESS_RE.test(element);
}

/** True for a list of 1 to 200 exact addresses or host names. */
export function validSources(list: string[]): boolean {
  return list.length >= 1 && list.length <= MAX_SOURCES && list.every(validElement);
}

/** Parse the value of `SSH_ORIGINAL_COMMAND`. It is undefined for anything that is not exactly one grammar form. */
export function parseCommand(text: string): ProvisionerCommand | undefined {
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) return undefined;
  if (text === "on" || text === "off" || text === "status" || text === "uninstall") return { kind: text };
  if (!text.startsWith("sources ")) return undefined;
  const list = text.slice("sources ".length).split(",");
  return validSources(list) ? { kind: "sources", list } : undefined;
}

/** The text of a command. It throws for a list that the grammar refuses. */
export function formatCommand(command: ProvisionerCommand): string {
  if (command.kind !== "sources") return command.kind;
  const text = `sources ${command.list.join(",")}`;
  if (!validSources(command.list) || parseCommand(text) === undefined) throw new Error("the source list is not valid");
  return text;
}

/** Parse the answer of the script or of the install script. Only the first line counts. */
export function parseAnswer(stdout: string): ProvisionerAnswer | undefined {
  const words = (stdout.split("\n", 1)[0] ?? "").split(" ");
  const [ok, word, second, third] = words;
  if (ok !== "ok") return undefined;
  if (words.length === 2 && (word === "off" || word === "uninstall")) return { kind: word };

  if (words.length === 3 && (word === "on" || word === "sources")) {
    const list = second.split(",");
    return validSources(list) ? { kind: word, list } : undefined;
  }

  if (words.length === 3 && word === "installed") {
    return SCRIPT_PATH_RE.test(second) ? { kind: "installed", path: second } : undefined;
  }

  if (word === "status" && (second === "present" || second === "absent")) {
    const present = second === "present";
    if (words.length === 3) return present ? undefined : { kind: "status", present, list: [] };
    const list = third.split(",");
    return words.length === 4 && validSources(list) ? { kind: "status", present, list } : undefined;
  }

  return undefined;
}

/** The provisioner line for `authorized_keys`: from, restrict and command in front of the key. */
export function provisionerLine(input: { publicLine: string; source: string; scriptPath: string }): string {
  const id = PROVISIONER_LINE_RE.exec(input.publicLine)?.[3];
  if (id === undefined || !HOST_ID_RE.test(id)) throw new Error("the provisioner key line is not valid");
  if (!ADDRESS_RE.test(input.source)) throw new Error("the source address is not valid");
  if (!SCRIPT_PATH_RE.test(input.scriptPath)) throw new Error("the script path is not valid");
  return `from="${input.source}",restrict,command="${input.scriptPath}" ${input.publicLine}`;
}

interface KeyParts {
  blob: string;
  comment: string;
}

function keyParts(line: string, re: RegExp, targetId: string, what: string): KeyParts {
  const match = re.exec(line);
  if (match?.[3] !== targetId) throw new Error(`the ${what} line is not valid for the target`);
  return { blob: match[1], comment: match[2] };
}

function checkTargetId(targetId: string): void {
  if (!HOST_ID_RE.test(targetId)) throw new Error("the target id is not valid");
}

// The script. Every value is quoted as data. The only input of the caller is `SSH_ORIGINAL_COMMAND`, and it must match
// the grammar before anything else happens. The list goes only into the `from="..."` part and into the state file.
//
// Order of each command: parse, refuse links, lock, read the state, edit a copy in the same folder, run the guard on the
// copy, and then one `mv`. The guard counts the lines of both keys, so an edit that would drop the provisioner line (the
// way back in) or that does not do what the command says stops with exit 4 before anything is written.

// Tests only (`guardTest`): a forced bad edit of the copy, to show that the guard stops the write. `true` drops the
// provisioner line, "main" adds a main line, and "other" drops the first line (a line of the owner).
function guardTestLines(kind: GuardTest): string[] {
  if (kind === "main") return ['  printf \'%s\\n\' "$mainkey" >> "$2" # guard-test'];
  if (kind === "other") return ['  sed 1d "$2" > "$2.h" && mv -f "$2.h" "$2" # guard-test'];
  return ['  strip "$pblob" "$pcomment" "$2" "$2.h" && mv -f "$2.h" "$2" # guard-test'];
}

function scriptLines(
  targetId: string,
  main: KeyParts,
  mainLine: string,
  provisionerBlob: string,
  guardTest: GuardTest | undefined,
): string[] {
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "LC_ALL=C",
    "export LC_ALL",
    `id=${shQuote(targetId)}`,
    `mainkey=${shQuote(mainLine)}`,
    `mblob=${shQuote(main.blob)}`,
    `mcomment=${shQuote(main.comment)}`,
    `pblob=${shQuote(provisionerBlob)}`,
    `pcomment=${shQuote(`claude-rc-provisioner:${targetId}`)}`,
    `prog=${shQuote(AWK_PROGRAM)}`,
    'dir="$HOME/.ssh"',
    'file="$dir/authorized_keys"',
    'cdir="$HOME/.claude-rc"',
    'self="$cdir/provisioner-$id.sh"',
    'state="$cdir/provisioner-$id.from"',
    'tmp="$file.tmp.$$"',
    'tmp2="$file.tmp2.$$"',
    'chk1="$file.chk1.$$"',
    'chk2="$file.chk2.$$"',
    'chk3="$file.chk3.$$"',
    'chk4="$file.chk4.$$"',
    'stmp="$state.tmp.$$"',
    "",
    'fail() { printf \'error %s %s\\n\' "$2" "$3" >&2; exit "$1"; }',
    "",
    // One list element is an exact address or host name: letters, digits, dot, colon, underscore and minus, not
    // starting with a minus. No wildcard, no slash, no space, no quote. Same rule as ADDRESS_RE in the hub.
    "valid_list() {",
    "  vl=$1; n=0",
    "  case $vl in '') return 1 ;; esac",
    "  while :; do",
    "    case $vl in",
    "      *,*) el=${vl%%,*}; vl=${vl#*,}; more=1 ;;",
    "      *) el=$vl; vl=; more=0 ;;",
    "    esac",
    "    case $el in '' | -* | *[!A-Za-z0-9._:-]*) return 1 ;; esac",
    '    [ "${#el}" -le 255 ] || return 1',
    "    n=$((n + 1))",
    '    [ "$n" -le 200 ] || return 1',
    '    [ "$more" = 1 ] || break',
    "  done",
    "  return 0",
    "}",
    "",
    "cmd=${SSH_ORIGINAL_COMMAND-}",
    '[ "${#cmd}" -le 4096 ] || fail 2 bad-command "the command is not valid"',
    "op=; list=",
    'case "$cmd" in',
    "  on | off | status | uninstall) op=$cmd ;;",
    "  'sources '*) op=sources; list=${cmd#sources } ;;",
    '  *) fail 2 bad-command "the command is not valid" ;;',
    "esac",
    'if [ "$op" = sources ] && ! valid_list "$list"; then fail 2 bad-command "the command is not valid"; fi',
    "",
    "safe() {",
    '  for p in "$dir" "$cdir" "$file" "$state"; do',
    '    if [ -L "$p" ]; then fail 3 unsafe-file "a key file, a state file or a folder is a symbolic link"; fi',
    "  done",
    '  if [ ! -f "$file" ] || [ ! -r "$file" ]; then fail 3 unsafe-file "the key file cannot be read"; fi',
    '  if [ -e "$state" ] && { [ ! -f "$state" ] || [ ! -r "$state" ]; }; then fail 3 unsafe-file "the state file cannot be read"; fi',
    "}",
    "safe",
    // The temporary files go away on any exit and on a signal.
    'trap \'rm -f "$tmp" "$tmp2" "$tmp.h" "$tmp2.h" "$stmp" "$chk1" "$chk2" "$chk3" "$chk4"\' EXIT',
    "trap 'exit 1' HUP INT TERM",
    ...LOCK_LINES,
    "safe",
    "",
    // The list of the state file. A list that does not pass the rule counts as no list.
    "cur=",
    'if [ -f "$state" ]; then read -r cur < "$state" || :; fi',
    'if ! valid_list "$cur"; then cur=; fi',
    "",
    'cnt() { RC_BLOB=$1 RC_COMMENT=$2 RC_MODE=count awk "$prog" "$3" || return 1; }',
    "# strip <blob> <comment> <in> <out> [<newline at the end: 0 or 1>]: the lines of the key go, other lines keep their bytes",
    "strip() {",
    "  nl=${5-}",
    '  if [ -z "$nl" ]; then',
    "    nl=0",
    '    if [ -n "$(tail -c 1 "$3")" ]; then nl=1; fi',
    "  fi",
    '  RC_BLOB=$1 RC_COMMENT=$2 RC_NONL=$nl RC_MODE=keep awk "$prog" "$3" > "$4" || fail 6 write-failed "the key file could not be edited"',
    "}",
    "# endnl <file>: a file that does not end with a newline gets one, so that an appended line stands alone",
    "endnl() {",
    '  if [ -n "$(tail -c 1 "$1")" ]; then printf \'\\n\' >> "$1" || fail 6 write-failed "the key file could not be edited"; fi',
    "}",
    "# append <file> <line>",
    "append() {",
    '  endnl "$1"',
    '  printf \'%s\\n\' "$2" >> "$1" || fail 6 write-failed "the key file could not be edited"',
    "}",
    "# others <in> <out>: every line that is neither the main nor the provisioner line, with a newline at the end",
    "others() {",
    '  strip "$mblob" "$mcomment" "$1" "$chk3" 0',
    '  strip "$pblob" "$pcomment" "$chk3" "$2" 0',
    "}",
    "# guard <old file> <new file> <lines of the provisioner key> <lines of the main key>",
    "# The new file must hold the wanted count of both keys, and every other line must be the same as in the old file.",
    "guard() {",
    ...(guardTest ? guardTestLines(guardTest) : []),
    '  gp=$(cnt "$pblob" "$pcomment" "$2") || fail 6 write-failed "the key file could not be checked"',
    '  gm=$(cnt "$mblob" "$mcomment" "$2") || fail 6 write-failed "the key file could not be checked"',
    '  if [ "$gp" != "$3" ] || [ "$gm" != "$4" ]; then fail 4 guard "the new key file failed the check, nothing was written"; fi',
    '  others "$1" "$chk1"',
    '  others "$2" "$chk2"',
    '  if ! cmp -s "$chk1" "$chk2"; then fail 4 guard "the new key file failed the check, nothing was written"; fi',
    "}",
    "commit() {",
    '  chmod 600 "$1" || fail 6 write-failed "the key file could not be replaced"',
    '  mv -f "$1" "$file" || fail 6 write-failed "the key file could not be replaced"',
    "}",
    "prepare() {",
    '  cp -p "$file" "$1" 2>/dev/null || fail 6 write-failed "cannot make a temporary file in the key folder"',
    "}",
    "# put_state <list>: write the state file next to itself and rename it",
    "put_state() {",
    '  printf \'%s\\n\' "$1" > "$stmp" || fail 6 write-failed "the state file could not be written"',
    '  mv -f "$stmp" "$state" || fail 6 write-failed "the state file could not be replaced"',
    "}",
    "",
    'm=$(cnt "$mblob" "$mcomment" "$file") || fail 6 write-failed "the key file could not be checked"',
    'case "$op" in',
    "  on)",
    '    [ -n "$cur" ] || fail 5 no-sources "no list of addresses is stored"',
    '    line="from=\\"$cur\\",restrict $mainkey"',
    '    if [ "$m" = 1 ] && grep -qxF -- "$line" "$file"; then :; else',
    '      prepare "$tmp"',
    '      strip "$mblob" "$mcomment" "$file" "$tmp"',
    '      append "$tmp" "$line"',
    '      guard "$file" "$tmp" 1 1',
    '      commit "$tmp"',
    "    fi",
    "    printf 'ok on %s\\n' \"$cur\"",
    "    ;;",
    "  off)",
    '    if [ "$m" != 0 ]; then',
    '      prepare "$tmp"',
    '      strip "$mblob" "$mcomment" "$file" "$tmp"',
    '      guard "$file" "$tmp" 1 0',
    '      commit "$tmp"',
    "    fi",
    "    echo 'ok off'",
    "    ;;",
    "  status)",
    "    here=absent",
    '    if [ -n "$cur" ] && [ "$m" = 1 ] && grep -qxF -- "from=\\"$cur\\",restrict $mainkey" "$file"; then here=present; fi',
    '    if [ -n "$cur" ]; then printf \'ok status %s %s\\n\' "$here" "$cur"; else printf \'ok status %s\\n\' "$here"; fi',
    "    ;;",
    "  sources)",
    '    if [ "$m" != 0 ]; then',
    '      prepare "$tmp"',
    '      strip "$mblob" "$mcomment" "$file" "$tmp"',
    '      append "$tmp" "from=\\"$list\\",restrict $mainkey"',
    '      guard "$file" "$tmp" 1 1',
    '      commit "$tmp"',
    "    fi",
    '    put_state "$list"',
    "    printf 'ok sources %s\\n' \"$list\"",
    "    ;;",
    "  uninstall)",
    '    prepare "$tmp"',
    '    strip "$mblob" "$mcomment" "$file" "$tmp"',
    '    prepare "$tmp2"',
    '    strip "$pblob" "$pcomment" "$tmp" "$tmp2"',
    '    guard "$file" "$tmp2" 0 0',
    '    commit "$tmp2"',
    '    rm -f "$state" "$self"',
    '    rmdir "$cdir" 2>/dev/null || :',
    "    echo 'ok uninstall'",
    "    ;;",
    "esac",
    "",
  ];
}

/**
 * The text of the Linux script that sshd runs for the provisioner key. It is a `/bin/sh` script (POSIX, no bashisms).
 * The key file is always `~/.ssh/authorized_keys`: a key file name (`keyFile`) exists only for managed targets, and the
 * provisioner exists only for external targets.
 * `guardTest` is for tests only: it adds a line that forces a bad edit of the copy, so that a test can show that the
 * guard stops it. The normal text holds no such line.
 */
export function linuxScript(input: {
  targetId: string;
  mainPublicLine: string;
  provisionerBlob: string;
  guardTest?: GuardTest;
}): string {
  checkTargetId(input.targetId);
  const main = keyParts(input.mainPublicLine, MAIN_LINE_RE, input.targetId, "main key");
  if (!BLOB_RE.test(input.provisionerBlob)) throw new Error("the provisioner key blob is not valid");
  return scriptLines(input.targetId, main, input.mainPublicLine, input.provisionerBlob, input.guardTest).join("\n");
}

/**
 * The install script for the target (run once with the key of the owner, on stdin of `sh`). It writes
 * `$HOME/.claude-rc/provisioner-<id>.sh` (mode 700) and its `.from` state file (mode 600), then adds the provisioner line
 * to `authorized_keys`. It prints `ok installed <path>`. A link or a home path that the `command=` option cannot hold
 * stops it with exit 1 and a message on stderr.
 */
export function linuxInstallScript(input: {
  targetId: string;
  mainPublicLine: string;
  provisionerPublicLine: string;
  localSource: string;
  sources: string[];
}): Script {
  checkTargetId(input.targetId);
  const provisioner = keyParts(input.provisionerPublicLine, PROVISIONER_LINE_RE, input.targetId, "provisioner key");
  const text = linuxScript({
    targetId: input.targetId,
    mainPublicLine: input.mainPublicLine,
    provisionerBlob: provisioner.blob,
  });
  if (!ADDRESS_RE.test(input.localSource)) throw new Error("the source address is not valid");
  if (!validSources(input.sources)) throw new Error("the source list is not valid");
  const lines = [
    "set -eu",
    "umask 077",
    "LC_ALL=C",
    "export LC_ALL",
    `body=${shQuote(text)}`,
    `list=${shQuote(input.sources.join(","))}`,
    `pub=${shQuote(input.provisionerPublicLine)}`,
    `RC_BLOB=${shQuote(provisioner.blob)}`,
    `RC_COMMENT=${shQuote(provisioner.comment)}`,
    "export RC_BLOB RC_COMMENT",
    `prog=${shQuote(AWK_PROGRAM)}`,
    'dir="$HOME/.ssh"',
    'file="$dir/authorized_keys"',
    'cdir="$HOME/.claude-rc"',
    `self="$cdir/provisioner-${input.targetId}.sh"`,
    `state="$cdir/provisioner-${input.targetId}.from"`,
    // The path goes into `command="..."`, and sshd gives it to a shell.
    'case "$self" in',
    `  /*[!${SCRIPT_PATH_CLASS}]* | '') echo "the home folder path cannot go into the key line" >&2; exit 1 ;;`,
    `  /*) ;;`,
    '  *) echo "the home folder path is not absolute" >&2; exit 1 ;;',
    "esac",
    'if [ "${#self}" -gt 1024 ]; then echo "the home folder path is too long for the key line" >&2; exit 1; fi',
    'for p in "$dir" "$cdir" "$self" "$state" "$file"; do',
    '  if [ -L "$p" ]; then echo "a key file, a state file or a folder is a symbolic link" >&2; exit 1; fi',
    "done",
    'mkdir -p "$dir" "$cdir"',
    'chmod 700 "$dir" "$cdir"',
    'for p in "$dir" "$cdir"; do',
    '  if [ -L "$p" ]; then echo "a folder is a symbolic link" >&2; exit 1; fi',
    "done",
    ...LOCK_LINES,
    // The script and the state file first, so that the line never points at a missing script.
    'trap \'rm -f "$self.tmp.$$" "$state.tmp.$$" "$file.tmp.$$"\' EXIT',
    "trap 'exit 1' HUP INT TERM",
    'printf \'%s\\n\' "$body" > "$self.tmp.$$"',
    'chmod 700 "$self.tmp.$$"',
    'mv -f "$self.tmp.$$" "$self"',
    'printf \'%s\\n\' "$list" > "$state.tmp.$$"',
    'chmod 600 "$state.tmp.$$"',
    'mv -f "$state.tmp.$$" "$state"',
    'touch "$file"',
    'chmod 600 "$file"',
    `line="from=\\"${input.localSource}\\",restrict,command=\\"$self\\" $pub"`,
    'count=$(RC_MODE=count awk "$prog" "$file")',
    'if [ "$count" = 1 ] && grep -qxF -- "$line" "$file"; then',
    "  :",
    "else",
    '  cp -p "$file" "$file.tmp.$$"',
    '  RC_MODE=keep RC_NONL=0 awk "$prog" "$file" > "$file.tmp.$$"',
    '  printf \'%s\\n\' "$line" >> "$file.tmp.$$"',
    '  mv -f "$file.tmp.$$" "$file"',
    "fi",
    'echo "ok installed $self"',
    "",
  ];
  return { shell: "sh", script: lines.join("\n") };
}
