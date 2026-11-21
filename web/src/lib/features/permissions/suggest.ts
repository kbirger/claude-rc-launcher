import type { BlockedCall } from "./api";

export type Suggestion = { raw: string; label: string; broad: boolean; note?: string };

const TWO_WORD = new Set(["git", "npm", "bun", "docker", "kubectl"]);
const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit"]);
// Commands that run other commands or arbitrary code: a prefix rule on them would allow anything.
const NO_PREFIX = new Set([
  "sudo",
  "doas",
  "su",
  "env",
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "eval",
  "exec",
  "source",
  ".",
  "xargs",
  "nohup",
  "time",
  "timeout",
  "nice",
  "ionice",
  "watch",
  "command",
  "builtin",
  "setsid",
  "stdbuf",
  "ssh",
  "python",
  "python3",
  "node",
  "deno",
  "perl",
  "ruby",
  "php",
  "lua",
  "awk",
  "find",
  "script",
  // Shell keywords: the rest of the line is a command, or part of a block.
  "for",
  "while",
  "until",
  "if",
  "case",
  "do",
  "then",
  "done",
  "fi",
  "esac",
  "select",
  "function",
  // Runners: they start any program.
  "npx",
  "bunx",
  "uvx",
  "pipx",
  "pnpm",
  "yarn",
  "tsx",
  "make",
  "parallel",
  "tmux",
  "screen",
  "systemd-run",
  "flock",
  "strace",
  "gdb",
  "chroot",
  "busybox",
  // Other shells.
  "pwsh",
  "powershell",
  "csh",
  "tcsh",
]);

/** The command name for the denylist: the basename of the first word, without a trailing version (`python3.12` is `python`). */
const commandName = (word: string): string => {
  const base = word.slice(word.lastIndexOf("/") + 1);
  return base.replace(/[\d.]+$/, "") || base;
};

const noPrefix = (word: string): boolean =>
  NO_PREFIX.has(word) || NO_PREFIX.has(commandName(word)) || /^[{}(]/.test(word);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const UNSPLITTABLE = /\$\(|`|<\(|>\(|^\(/;

const withStar = (raw: string, label: string, broad = false): Suggestion =>
  raw.includes("*")
    ? { raw, label, broad: true, note: "Contains *, which matches more than this exact text." }
    : { raw, label, broad };
// Newline is allowed (it separates commands); any other control character is not. `[^\P{Cc}…]` reads as: a control character
// (\p{Cc}) that is not newline and not one of the C1 controls (U+0080 to U+009F).
const CONTROL = /[^\P{Cc}\n\u0080-\u009f]/u;

/** Splits a shell command on && || ; | & and newline outside quotes. Honors backslash escapes. */
function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;

  const flush = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = "";
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;

    if (quote) {
      cur += char;
      if (char === "\\" && quote === '"' && index + 1 < command.length) cur += command[++index];
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      cur += char + command[++index];
    } else if (char === "'" || char === '"') {
      quote = char;
      cur += char;
    } else if (char === "\n" || char === ";" || char === "|") {
      flush();
      if (char === "|" && command[index + 1] === "|") index++;
    } else if (char === "&") {
      // `2>&1`, `>&2` and `&>file` are redirections, not separators.
      const redirect = /[<>]/.test(command[index - 1] ?? "") || command[index + 1] === ">";

      if (redirect) cur += char;
      else {
        flush();
        if (command[index + 1] === "&") index++;
      }
    } else cur += char;
  }

  flush();
  return parts;
}

/** The commands of a shell command line, for matching. A line that cannot be split safely is one command. Empty for control characters. */
export function bashParts(command: string): string[] {
  if (CONTROL.test(command)) return [];
  const whole = command.trim();
  if (!whole) return [];
  return UNSPLITTABLE.test(whole) ? [whole] : splitCommand(command);
}

function bashSuggestions(command: string): Suggestion[] {
  if (CONTROL.test(command)) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();

  const add = (suggestion: Suggestion) => {
    if (!seen.has(suggestion.raw)) {
      seen.add(suggestion.raw);
      out.push(suggestion);
    }
  };

  // Substitution, backticks and subshells cannot be split safely: one exact rule for the whole command.
  const whole = command.trim();
  if (!whole) return [];
  if (UNSPLITTABLE.test(whole)) return [withStar(`Bash(${whole})`, `Exactly: ${whole}`)];

  for (const part of splitCommand(command)) {
    add(withStar(`Bash(${part})`, `Exactly: ${part}`));
    const words = part.split(/\s+/);
    if (noPrefix(words[0]!) || ENV_ASSIGNMENT.test(words[0]!)) continue;
    const wordCount = TWO_WORD.has(words[0]!) && words.length > 1 ? 2 : 1;
    if (wordCount === 2 && words[1]!.startsWith("-")) continue;

    if (words.length > wordCount) {
      const prefix = words.slice(0, wordCount).join(" ");
      add({ raw: `Bash(${prefix} *)`, label: `Any ${prefix} command`, broad: true });
    }
  }

  return out;
}

const bare = (tool: string): Suggestion[] => [{ raw: tool, label: `Every use of ${tool}`, broad: true }];

/** Suggests allow rules for a blocked call from its tool and input only, never from the denial text. */
export function suggestRules(call: BlockedCall): Suggestion[] {
  const { tool, input } = call;

  if (tool === "Bash") {
    return typeof input.command === "string" ? bashSuggestions(input.command) : [];
  }

  if (FILE_TOOLS.has(tool)) {
    // A bare Edit, Write or Read allows every path, so without a usable path there is no suggestion.
    const path = tool === "NotebookEdit" ? (input.notebook_path ?? input.file_path) : input.file_path;
    // No control character at all, newline included: a rule is one line of text.
    if (typeof path !== "string" || !path || /[^\P{Cc}\u0080-\u009f]/u.test(path)) return [];
    // Claude Code reads `/path` as relative to the settings file's folder. An absolute path needs two slashes.
    const rulePath = path.startsWith("/") && !path.startsWith("//") ? `/${path}` : path;
    return [withStar(`${tool}(${rulePath})`, `Only ${path}`)];
  }

  if (tool === "WebFetch") {
    try {
      const host = new URL(String(input.url)).hostname;
      return host ? [{ raw: `WebFetch(domain:${host})`, label: `Any page on ${host}`, broad: true }] : bare(tool);
    } catch {
      return bare(tool);
    }
  }

  return bare(tool);
}
