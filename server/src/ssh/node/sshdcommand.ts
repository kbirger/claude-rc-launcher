import { MANAGED_KEY_FILE } from "../constants";
import type { SshdDropin } from "./SshdDropin";

// The `install`, `check` and `remove` words of the sshd drop-in, as a command: `claude-rc-launcher sshd-dropin` on a
// node. The command prints the reload state after an install and a removal.

const WORDS = ["install", "check", "remove"] as const;
type Word = (typeof WORDS)[number];
const ENTRY = `.ssh/${MANAGED_KEY_FILE}`;
const RELOADED = "sshd was reloaded.";

export interface SshdCommandDeps {
  dropin: SshdDropin;
  out: (line: string) => void;
  err: (line: string) => void;
  platform: NodeJS.Platform;
}

const isWord = (sub: string | undefined): sub is Word => WORDS.includes(sub as Word);

/** Runs one word. Exit code 0: done, or sshd reads the file. 1: an error, or sshd does not read the file. 2: a wrong word. */
export async function runSshdCommand(sub: string | undefined, deps: SshdCommandDeps): Promise<number> {
  const { dropin, out, err } = deps;

  if (deps.platform !== "linux") {
    err("the sshd drop-in works on Linux only");
    return 1;
  }

  if (!isWord(sub)) {
    err(`usage: ${dropin.command} install|check|remove`);
    return 2;
  }

  try {
    return await runWord(sub, dropin, out);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runWord(word: Word, dropin: SshdDropin, out: (line: string) => void): Promise<number> {
  switch (word) {
    case "install": {
      const result = await dropin.install();

      if (result.kind === "unchanged") {
        out(`sshd reads ${ENTRY} already. No change.`);
        return 0;
      }

      out(`installed ${dropin.dropinPath}: AuthorizedKeysFile ${result.list.join(" ")}`);
      out(result.reloaded ? RELOADED : (result.note ?? "sshd was not reloaded."));
      return 0;
    }

    case "check": {
      const check = await dropin.check();

      if (check.reads) {
        out(`sshd reads ${ENTRY} (AuthorizedKeysFile ${check.list.join(" ")})`);
        return 0;
      }

      out(`sshd does not read ${ENTRY}. Run: sudo ${dropin.command} install`);
      return 1;
    }

    case "remove": {
      const result = await dropin.remove();

      if (result.kind === "absent") {
        out("no drop-in to remove");
        return 0;
      }

      out(`removed ${dropin.dropinPath}`);
      out(result.reloaded ? RELOADED : (result.note ?? "sshd was not reloaded."));
      return 0;
    }
  }
}
