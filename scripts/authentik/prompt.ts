import { createInterface } from "node:readline/promises";
import { applySetting, publicOrigin } from "./settings";
import type { Parsed } from "./settings";

export interface Io {
  ask(question: string): Promise<string>;
  tty: boolean;
}

export function realIo(): { io: Io; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    io: { ask: (item) => rl.question(item), tty: !!(process.stdin.isTTY && process.stdout.isTTY) },
    close: () => {
      rl.close();
    },
  };
}

const GROUP_SUFFIX = "-admins";

/** Asks for the settings that the operator can choose. An empty answer keeps the value in brackets. An invalid answer asks again. */
export async function askSettings(base: Parsed, io: Io): Promise<Parsed> {
  if (!io.tty) throw new Error("--interactive needs a terminal. Pass the settings as flags instead");
  let parsed: Parsed = { ...base };

  const ask = async (
    label: string,
    current: string,
    apply: (value: string) => Parsed,
    optional = false,
  ): Promise<void> => {
    let note = "";

    for (;;) {
      const answer = (await io.ask(`${note}${label}${current ? ` [${current}]` : ""}: `)).trim();
      if (answer === "" && (current || optional)) return;

      if (answer === "") {
        note = "A value is required.\n";
        continue;
      }

      try {
        parsed = apply(answer);
        return;
      } catch (error) {
        note = `${(error as Error).message}\n`;
      }
    }
  };

  await ask("Public URL of the hub", parsed.publicUrl, (value) => ({ ...parsed, publicUrl: publicOrigin(value) }));
  await ask("Slug of the web application", parsed.settings.webApp.slug, (value) => ({
    ...parsed,
    settings: applySetting(parsed.settings, "WEB_SLUG", value),
  }));
  await ask("Slug of the CLI application", parsed.settings.cliApp.slug, (value) => ({
    ...parsed,
    settings: applySetting(parsed.settings, "CLI_SLUG", value),
  }));
  await ask(
    "Prefix of the three role groups",
    parsed.settings.adminGroup.endsWith(GROUP_SUFFIX)
      ? parsed.settings.adminGroup.slice(0, -GROUP_SUFFIX.length)
      : parsed.settings.adminGroup,
    (value) => ({ ...parsed, settings: applySetting(parsed.settings, "GROUP_PREFIX", value) }),
  );
  await ask("Name of the role claim", parsed.settings.claim, (value) => ({
    ...parsed,
    settings: applySetting(parsed.settings, "CLAIM", value),
  }));
  await ask("Name of the role scope", parsed.settings.scope, (value) => ({
    ...parsed,
    settings: applySetting(parsed.settings, "SCOPE", value),
  }));
  await ask(
    "Username that becomes an admin (optional)",
    parsed.settings.adminUser ?? "",
    (value) => ({ ...parsed, settings: applySetting(parsed.settings, "ADMIN_USER", value) }),
    true,
  );
  return parsed;
}
