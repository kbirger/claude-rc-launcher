import { isIP } from "node:net";
import { HOST_ID_RE } from "../../hosts/id";
import { AWK_PROGRAM, LOCK_LINES, shQuote } from "../provision";
import type { Script } from "../provision";
import { ADDRESS_RE, DROPBEAR_OPTIONS, SCRIPT_PATH_RE } from "../TargetStore";

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

// The grammar: `fail`, the rule for a list, and the parse of `SSH_ORIGINAL_COMMAND` into `op` and `list`. The Linux and
// the router script share it, so both take exactly the same forms.
const GRAMMAR_LINES = [
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
];

// The edit helpers and the guard on two files of lines. They use `$prog`, `$mblob`, `$mcomment`, `$pblob`, `$pcomment`
// and the check files `$chk1` to `$chk3`. The Linux and the router script share them.
function editLines(guardTest: GuardTest | undefined): string[] {
  return [
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
    "# others <in> <out>: every line that is neither the main line nor a provisioner line (any key), with a newline at the end",
    "others() {",
    '  strip "$mblob" "$mcomment" "$1" "$chk3" 0',
    '  strip "*" "$pcomment" "$chk3" "$2" 0',
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
  ];
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
    ...GRAMMAR_LINES,
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
    ...editLines(guardTest),
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
    '    strip "*" "$pcomment" "$tmp" "$tmp2"',
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
    // `*`: every provisioner line of this target goes, also the line of an older key after a key replacement.
    "RC_BLOB='*'",
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

// The router version: Dropbear on Asuswrt-Merlin, BusyBox `sh`. Facts from the source of the firmware (the report of
// Task 8 cites the files):
// - The key list lives in the nvram variable `sshd_authkeys`. The web page stores the lines joined with `>` (a newline
//   becomes `>`, a CR goes). At each start of sshd, the firmware copies at most 3499 bytes of the value, turns each `>`
//   into a newline and writes `/root/.ssh/authorized_keys`. A longer value is cut at boot, maybe in a line.
// - The `nvram` program exits with 0 even when a set or a commit fails. So the script reads the value back after
//   `nvram set`, and it cannot see a failed `commit` unless the program reports it.
// - Dropbear has no `from=` option, and it refuses a whole key line with an option that it does not know. So no line on
//   the router has `from=`. The provisioner script compares the client address itself (`SSH_CONNECTION`). The main key
//   is not limited by address on the router: the approval of the hub is the control.
// - `restrict` exists since Dropbear 2022.82. `command=` sets `SSH_ORIGINAL_COMMAND`.
// - BusyBox ash of Merlin is built without the builtin `command`, so the script never uses it.
// NOT VERIFIED on a router: the exact BusyBox applets of each model, whether /jffs allows exec, the Dropbear version of
// the firmware in use, and how `nvram commit` fails.

/** The most bytes of `sshd_authkeys` that the firmware copies to the live file at boot (`char buf[3500]`, `strlcpy`). */
export const ROUTER_MAX_VALUE = 3499;

/** The BusyBox applets that the router scripts use. Merlin's `busybox/config_base` turns on each of them. */
export const ROUTER_APPLETS = [
  "[",
  "awk",
  "cat",
  "chmod",
  "cmp",
  "cp",
  "echo",
  "grep",
  "head",
  "mkdir",
  "mv",
  "printf",
  "rm",
  "rmdir",
  "sh",
  "sleep",
  "tail",
  "test",
  "tr",
  "wc",
] as const;

/** The path of the router script. `/jffs` survives a reboot, and `/jffs/scripts` is where Merlin keeps scripts. */
export function routerScriptPath(targetId: string): string {
  checkTargetId(targetId);
  return `/jffs/scripts/claude-rc-provisioner-${targetId}.sh`;
}

// In Dropbear, `restrict` sets exactly the four flags of `DROPBEAR_OPTIONS`, and `restrict` came in 2022.82. The four
// flags work in every version, so the provisioner line uses them too.
const ROUTER_OPTIONS = DROPBEAR_OPTIONS;

/** The provisioner line for Dropbear: the four `no-` flags and command, no `from=` (Dropbear refuses it). The script checks the source. */
export function routerProvisionerLine(input: { publicLine: string; scriptPath: string }): string {
  const id = PROVISIONER_LINE_RE.exec(input.publicLine)?.[3];
  if (id === undefined || !HOST_ID_RE.test(id)) throw new Error("the provisioner key line is not valid");
  if (!SCRIPT_PATH_RE.test(input.scriptPath)) throw new Error("the script path is not valid");
  return `${ROUTER_OPTIONS},command="${input.scriptPath}" ${input.publicLine}`;
}

/** The source of `local` for the router: an IP address, because the script compares it with the client address. */
function checkRouterSource(source: string): void {
  if (!ADDRESS_RE.test(source) || isIP(source) === 0) throw new Error("the source address must be an IP address");
}

/** Tests only: the folder that stands in for `/`. Empty on a router. */
function rootPrefix(root: string | undefined): string {
  if (root === undefined) return "";
  if (!SCRIPT_PATH_RE.test(root)) throw new Error("the root folder is not valid");
  return root;
}

// The paths, the lock and the temporary folder. The temporary files are in `/tmp` (RAM), not in `/jffs` (flash).
function routerPathLines(root: string): string[] {
  return [
    `root=${shQuote(root)}`,
    'dir="$root/root/.ssh"',
    'file="$dir/authorized_keys"',
    'cdir="$root/jffs/scripts"',
    'self="$cdir/claude-rc-provisioner-$id.sh"',
    'state="$cdir/claude-rc-provisioner-$id.from"',
    'lock="$root/tmp/claude-rc-provisioner.lock"',
    'work="$root/tmp/claude-rc-provisioner-$id.$$"',
    'ltmp="$file.tmp.$$"',
    'stmp="$state.tmp.$$"',
    'oldv="$work/old.v"',
    'oldl="$work/old.l"',
    'newl="$work/new.l"',
    'newv="$work/new.v"',
    'backv="$work/back.v"',
    'chk1="$work/chk1"',
    'chk2="$work/chk2"',
    'chk3="$work/chk3"',
    'chk4="$work/chk4"',
    "locked=0",
    "lf='",
    "'",
  ];
}

// The lock is a folder: Merlin has no flock. One lock for all targets, because they share one nvram value. A lock that
// a killed run left behind stays until the next reboot (`/tmp` is RAM).
const ROUTER_LOCK_LINES = [
  'trap \'rm -rf "$work"; rm -f "$ltmp" "$stmp" "$self.tmp.$$"; if [ "$locked" = 1 ]; then rmdir "$lock" 2>/dev/null || :; fi\' EXIT',
  "trap 'exit 1' HUP INT TERM",
  'mkdir "$work" 2>/dev/null || fail 6 write-failed "a temporary folder could not be made"',
  "tries=0",
  'while ! mkdir "$lock" 2>/dev/null; do',
  "  tries=$((tries + 1))",
  '  [ "$tries" -lt 30 ] || fail 6 write-failed "another change holds the lock. A reboot of the router clears it"',
  "  sleep 1",
  "done",
  "locked=1",
];

// The nvram helpers. `nvram get` prints the value and one newline, so a sentinel keeps the trailing bytes. The format
// found is kept: the separator (`>` as the web page writes it, or a newline) and whether the value ends with it.
const ROUTER_NVRAM_LINES = [
  "# nv_read <file>: the value of sshd_authkeys, byte for byte",
  "nv_read() {",
  '  nvv=$(nvram get sshd_authkeys && printf x) || fail 3 unsafe-file "the key list in nvram cannot be read"',
  "  nvv=${nvv%x}",
  '  nvv=${nvv%"$lf"}',
  '  printf \'%s\' "$nvv" > "$1" || fail 6 write-failed "a temporary file could not be written"',
  "}",
  "# nv_format <file>: sets sep, sepc and trail for the value in the file",
  "nv_format() {",
  "  hasgt=0; hasnl=0",
  "  if grep -q '>' \"$1\"; then hasgt=1; fi",
  '  nlines=$(wc -l < "$1") || fail 3 unsafe-file "the key list in nvram cannot be read"',
  '  if [ "$((nlines))" -gt 0 ]; then hasnl=1; fi',
  '  if [ "$hasgt" = 1 ] && [ "$hasnl" = 1 ]; then fail 3 unsafe-file "the key list in nvram holds both > and newline as separators"; fi',
  "  sep='>'; sepc='>'",
  '  if [ "$hasnl" = 1 ]; then sep=newline; sepc=$lf; fi',
  "  trail=0",
  '  if [ -s "$1" ]; then',
  '    last=$(tail -c 1 "$1" && printf x) || fail 3 unsafe-file "the key list in nvram cannot be read"',
  "    last=${last%x}",
  '    if [ "$last" = "$sepc" ]; then trail=1; fi',
  "  fi",
  "}",
  "# nv_lines <value file> <lines file>: the lines as the firmware writes them to the live file",
  "nv_lines() {",
  '  tr \'>\' \'\\n\' < "$1" > "$2" || fail 6 write-failed "a temporary file could not be written"',
  "}",
  "# nv_value <lines file> <value file>: the value in the format that was found",
  "nv_value() {",
  '  if [ "$sep" = \'>\' ]; then tr \'\\n\' \'>\' < "$1" > "$2"; else cp "$1" "$2"; fi || fail 6 write-failed "a temporary file could not be written"',
  '  nvv=$(cat "$2" && printf x) || fail 6 write-failed "a temporary file could not be read"',
  "  nvv=${nvv%x}",
  '  if [ "$trail" = 0 ]; then nvv=${nvv%"$sepc"}; fi',
  '  printf \'%s\' "$nvv" > "$2" || fail 6 write-failed "a temporary file could not be written"',
  "}",
  "# nv_count <lines file>: the lines that are not empty",
  'nv_count() { grep -c . "$1" || :; }',
  "# restore: the old value back into nvram (no commit), after a failed write",
  "restore() {",
  '  nvv=$(cat "$oldv" && printf x) || return 0',
  "  nvv=${nvv%x}",
  '  nvram set "sshd_authkeys=$nvv" >/dev/null 2>&1 || :',
  "}",
  "# live <lines file>: the live key file gets these lines, through a temporary file and a rename",
  "live() {",
  '  if [ -f "$file" ] && cmp -s "$1" "$file"; then return 0; fi',
  '  if cp "$1" "$ltmp" && chmod 600 "$ltmp" && mv -f "$ltmp" "$file"; then :; else',
  '    fail 6 write-failed "nvram holds the change, but the live key file could not be replaced. A reboot applies it"',
  "  fi",
  "}",
  "# put <old lines> <new lines> <lines of the provisioner key> <lines of the main key>",
  "# The guard runs on the new lines and on what the firmware will make of the new value, before nvram set. Then nvram",
  "# set, a read back, nvram commit, and the live file last. A failed step puts the old value back and stops.",
  "put() {",
  '  guard "$1" "$2" "$3" "$4"',
  '  nv_value "$2" "$newv"',
  '  nv_lines "$newv" "$chk4"',
  '  guard "$1" "$chk4" "$3" "$4"',
  '  size=$(wc -c < "$newv") || fail 6 write-failed "a temporary file could not be read"',
  `  if [ "$((size))" -gt ${ROUTER_MAX_VALUE} ]; then fail 4 guard "the key list would be longer than ${ROUTER_MAX_VALUE} bytes, nothing was written"; fi`,
  '  if ! cmp -s "$newv" "$oldv"; then',
  '    nvv=$(cat "$newv" && printf x) || fail 6 write-failed "a temporary file could not be read"',
  "    nvv=${nvv%x}",
  '    nvram set "sshd_authkeys=$nvv" >/dev/null 2>&1 || { restore; fail 6 write-failed "nvram set failed, nothing was changed"; }',
  '    nv_read "$backv"',
  '    if ! cmp -s "$backv" "$newv"; then restore; fail 6 write-failed "nvram did not take the new key list, nothing was changed"; fi',
  '    nvram commit >/dev/null 2>&1 || { restore; fail 6 write-failed "nvram commit failed, nothing was changed"; }',
  "  fi",
  '  live "$chk4"',
  "}",
  "# safe: no link at the key folder, the key file, the script folder and the state file",
  "safe() {",
  '  for p in "$dir" "$file" "$cdir" "$state"; do',
  '    if [ -L "$p" ]; then fail 3 unsafe-file "a key file, a state file or a folder is a symbolic link"; fi',
  "  done",
  '  if [ ! -d "$dir" ]; then fail 3 unsafe-file "the folder of the live key file is missing"; fi',
  '  if [ -e "$file" ] && { [ ! -f "$file" ] || [ ! -r "$file" ]; }; then fail 3 unsafe-file "the live key file cannot be read"; fi',
  '  if [ -e "$state" ] && { [ ! -f "$state" ] || [ ! -r "$state" ]; }; then fail 3 unsafe-file "the state file cannot be read"; fi',
  "}",
];

// The main line on a router: `authorizedKeysLine` with the system type `dropbear`, that is the four flags of
// `DROPBEAR_OPTIONS` and no `from=` (a ruling of the owner: Dropbear refuses `from=`, and old versions refuse
// `restrict`). The line does not depend on the list, so `mainline` ignores its argument. The state file still holds
// the list of the hub, for `status` and `on`.
const ROUTER_MAIN_LINE = `${DROPBEAR_OPTIONS} $mainkey`;

function routerScriptLines(
  targetId: string,
  main: KeyParts,
  mainLine: string,
  provisionerBlob: string,
  localSource: string,
  root: string,
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
    `localsrc=${shQuote(localSource)}`,
    `prog=${shQuote(AWK_PROGRAM)}`,
    ...routerPathLines(root),
    "",
    // `fail` comes first. Then the source check runs before the grammar, so that another address gets only
    // `bad-source` and learns nothing about the commands.
    GRAMMAR_LINES[0],
    "",
    // Dropbear has no `from=`: only the source of `local` may use this key. `SSH_CONNECTION` starts with the client
    // address. A client on an IPv6 socket can show an IPv4 address as `::ffff:<address>`.
    "src=${SSH_CONNECTION-}",
    'if [ -z "$src" ]; then src=${SSH_CLIENT-}; fi',
    "src=${src%% *}",
    'case "$src" in',
    '  "$localsrc" | "::ffff:$localsrc") ;;',
    '  *) fail 2 bad-source "the source address is not allowed" ;;',
    "esac",
    "",
    ...GRAMMAR_LINES.slice(1),
    "",
    ...editLines(guardTest),
    ...ROUTER_NVRAM_LINES,
    `mainline() { printf '%s' "${ROUTER_MAIN_LINE}"; }`,
    "# put_state <list>: the state file, only when the list changes (flash wear)",
    "put_state() {",
    '  if [ "$cur" = "$1" ] && [ -f "$state" ]; then return 0; fi',
    '  printf \'%s\\n\' "$1" > "$stmp" || fail 6 write-failed "the state file could not be written"',
    '  mv -f "$stmp" "$state" || fail 6 write-failed "the state file could not be replaced"',
    "}",
    "",
    "safe",
    ...ROUTER_LOCK_LINES,
    "safe",
    "",
    "cur=",
    'if [ -f "$state" ]; then read -r cur < "$state" || :; fi',
    'if ! valid_list "$cur"; then cur=; fi',
    'nv_read "$oldv"',
    'nv_format "$oldv"',
    'nv_lines "$oldv" "$oldl"',
    'm=$(cnt "$mblob" "$mcomment" "$oldl") || fail 6 write-failed "the key file could not be checked"',
    "",
    'case "$op" in',
    "  on)",
    '    [ -n "$cur" ] || fail 5 no-sources "no list of addresses is stored"',
    '    line=$(mainline "$cur")',
    '    if [ "$m" = 1 ] && grep -qxF -- "$line" "$oldl"; then live "$oldl"; else',
    '      strip "$mblob" "$mcomment" "$oldl" "$newl"',
    '      append "$newl" "$line"',
    '      put "$oldl" "$newl" 1 1',
    "    fi",
    "    printf 'ok on %s\\n' \"$cur\"",
    "    ;;",
    "  off)",
    '    if [ "$m" != 0 ]; then',
    '      strip "$mblob" "$mcomment" "$oldl" "$newl"',
    '      put "$oldl" "$newl" 1 0',
    '    else live "$oldl"; fi',
    "    echo 'ok off'",
    "    ;;",
    "  status)",
    "    here=absent",
    '    if [ -n "$cur" ] && [ "$m" = 1 ]; then',
    '      line=$(mainline "$cur")',
    '      if grep -qxF -- "$line" "$oldl" && [ -f "$file" ] && grep -qxF -- "$line" "$file"; then here=present; fi',
    "    fi",
    '    if [ -n "$cur" ]; then printf \'ok status %s %s\\n\' "$here" "$cur"; else printf \'ok status %s\\n\' "$here"; fi',
    "    ;;",
    "  sources)",
    // The line has no list: a present exact line stays as it is, and only the state file changes.
    '    line=$(mainline "$list")',
    '    if [ "$m" = 1 ] && grep -qxF -- "$line" "$oldl"; then :; elif [ "$m" != 0 ]; then',
    '      strip "$mblob" "$mcomment" "$oldl" "$newl"',
    '      append "$newl" "$line"',
    '      put "$oldl" "$newl" 1 1',
    "    fi",
    '    put_state "$list"',
    "    printf 'ok sources %s\\n' \"$list\"",
    "    ;;",
    "  uninstall)",
    '    strip "$mblob" "$mcomment" "$oldl" "$chk4"',
    '    strip "*" "$pcomment" "$chk4" "$newl"',
    '    put "$oldl" "$newl" 0 0',
    '    rm -f "$state" "$self"',
    "    echo 'ok uninstall'",
    "    ;;",
    "esac",
    "",
  ];
}

/**
 * The text of the router script that Dropbear runs for the provisioner key (`command=`). It is a BusyBox `sh` script
 * and uses only the applets in `ROUTER_APPLETS`. Each write runs the guard, then `nvram set sshd_authkeys`, a read
 * back, `nvram commit`, and then the live file `/root/.ssh/authorized_keys`. `root` and `guardTest` are for tests only.
 */
export function routerScript(input: {
  targetId: string;
  mainPublicLine: string;
  provisionerBlob: string;
  localSource: string;
  root?: string;
  guardTest?: GuardTest;
}): string {
  checkTargetId(input.targetId);
  const main = keyParts(input.mainPublicLine, MAIN_LINE_RE, input.targetId, "main key");
  if (!BLOB_RE.test(input.provisionerBlob)) throw new Error("the provisioner key blob is not valid");
  checkRouterSource(input.localSource);
  return routerScriptLines(
    input.targetId,
    main,
    input.mainPublicLine,
    input.provisionerBlob,
    input.localSource,
    rootPrefix(input.root),
    input.guardTest,
  ).join("\n");
}

/**
 * The install script for the router (run once with the key of the owner, on stdin of `sh`). It writes
 * `/jffs/scripts/claude-rc-provisioner-<id>.sh` (mode 700) and its `.from` state file (mode 600), then adds the
 * provisioner line to `sshd_authkeys` with the same guard and order as the script. It prints `ok installed <path>`,
 * then two `info` lines about the value it found and the value it wrote (counts only), and the Dropbear version when
 * it finds the program. `root` is for tests only.
 */
export function routerInstallScript(input: {
  targetId: string;
  mainPublicLine: string;
  provisionerPublicLine: string;
  localSource: string;
  sources: string[];
  root?: string;
}): Script {
  checkTargetId(input.targetId);
  const provisioner = keyParts(input.provisionerPublicLine, PROVISIONER_LINE_RE, input.targetId, "provisioner key");
  const main = keyParts(input.mainPublicLine, MAIN_LINE_RE, input.targetId, "main key");
  const root = rootPrefix(input.root);
  const text = routerScript({
    targetId: input.targetId,
    mainPublicLine: input.mainPublicLine,
    provisionerBlob: provisioner.blob,
    localSource: input.localSource,
    root: input.root,
  });
  if (!validSources(input.sources)) throw new Error("the source list is not valid");
  // The line with the real path, to check it here. The script builds the same line from `$self`.
  routerProvisionerLine({ publicLine: input.provisionerPublicLine, scriptPath: routerScriptPath(input.targetId) });
  const lines = [
    "set -eu",
    "umask 077",
    "LC_ALL=C",
    "export LC_ALL",
    `id=${shQuote(input.targetId)}`,
    `body=${shQuote(text)}`,
    `list=${shQuote(input.sources.join(","))}`,
    `pub=${shQuote(input.provisionerPublicLine)}`,
    `mainkey=${shQuote(input.mainPublicLine)}`,
    `mblob=${shQuote(main.blob)}`,
    `mcomment=${shQuote(main.comment)}`,
    `pblob=${shQuote(provisioner.blob)}`,
    `pcomment=${shQuote(provisioner.comment)}`,
    `prog=${shQuote(AWK_PROGRAM)}`,
    ...routerPathLines(root),
    'fail() { printf \'error %s %s\\n\' "$2" "$3" >&2; exit "$1"; }',
    ...editLines(undefined),
    ...ROUTER_NVRAM_LINES,
    `mainline() { printf '%s' "${ROUTER_MAIN_LINE}"; }`,
    // /jffs is the JFFS partition. Without it nothing survives a reboot. "Enable JFFS custom scripts" is not needed:
    // it gates only the scripts that the firmware runs on its own events.
    'if [ ! -d "$root/jffs" ] || [ ! -w "$root/jffs" ]; then fail 3 unsafe-file "the router has no writable /jffs. Turn on the JFFS partition"; fi',
    'for p in "$dir" "$file" "$cdir" "$self" "$state"; do',
    '  if [ -L "$p" ]; then fail 3 unsafe-file "a key file, a state file or a folder is a symbolic link"; fi',
    "done",
    'mkdir -p "$cdir" || fail 6 write-failed "the folder /jffs/scripts could not be made"',
    'if [ -L "$cdir" ]; then fail 3 unsafe-file "a folder is a symbolic link"; fi',
    "safe",
    ...ROUTER_LOCK_LINES,
    "safe",
    // The script and the state file first, so that the line never points at a missing script. A file that is the
    // same already is not written again (flash wear).
    "# keep <text> <path> <tmp> <mode>",
    "keep() {",
    '  printf \'%s\\n\' "$1" > "$work/keep" || fail 6 write-failed "a temporary file could not be written"',
    '  if [ -f "$2" ] && cmp -s "$work/keep" "$2"; then chmod "$4" "$2"; return 0; fi',
    '  if cp "$work/keep" "$3" && chmod "$4" "$3" && mv -f "$3" "$2"; then :; else fail 6 write-failed "a file in /jffs/scripts could not be written"; fi',
    "}",
    'keep "$body" "$self" "$self.tmp.$$" 700',
    'keep "$list" "$state" "$stmp" 600',
    'nv_read "$oldv"',
    'nv_format "$oldv"',
    'nv_lines "$oldv" "$oldl"',
    'had="$(nv_count "$oldl") lines, separator $sep, $(($(wc -c < "$oldv"))) of ' + `${ROUTER_MAX_VALUE} bytes"`,
    `line="${ROUTER_OPTIONS},command=\\"$self\\" $pub"`,
    // `*`: a provisioner line of an older key (after a key replacement) counts too, so that the write removes it.
    'p=$(cnt "*" "$pcomment" "$oldl") || fail 6 write-failed "the key file could not be checked"',
    'm=$(cnt "$mblob" "$mcomment" "$oldl") || fail 6 write-failed "the key file could not be checked"',
    // The add of a target writes the main line into the live file only. The write below makes the live file from nvram,
    // so a main line that is only in the live file goes into nvram too (with the list of the hub), and the test of the
    // add still finds it.
    "lm=0",
    'if [ -f "$file" ]; then lm=$(cnt "$mblob" "$mcomment" "$file") || fail 6 write-failed "the key file could not be checked"; fi',
    "carry=0",
    'if [ "$m" = 0 ] && [ "$lm" != 0 ]; then carry=1; fi',
    'if [ "$p" = 1 ] && grep -qxF -- "$line" "$oldl" && [ "$carry" = 0 ]; then',
    '  cp "$oldv" "$newv"',
    '  live "$oldl"',
    "else",
    '  strip "*" "$pcomment" "$oldl" "$newl"',
    '  append "$newl" "$line"',
    '  if [ "$carry" = 1 ]; then append "$newl" "$(mainline "$list")"; m=1; fi',
    '  put "$oldl" "$newl" 1 "$m"',
    "fi",
    'nv_lines "$newv" "$chk4"',
    'echo "ok installed $self"',
    'echo "info nvram sshd_authkeys had $had"',
    'echo "info nvram sshd_authkeys has $(nv_count "$chk4") lines, separator $sep, $(($(wc -c < "$newv"))) of ' +
      `${ROUTER_MAX_VALUE} bytes"`,
    'for d in "$root/usr/sbin/dropbear" "$root/usr/bin/dropbear"; do',
    '  if [ -x "$d" ]; then echo "info dropbear $("$d" -V 2>&1 | head -n 1)"; break; fi',
    "done",
    "",
  ];
  return { shell: "sh", script: lines.join("\n") };
}
