import { createInterface } from "node:readline/promises";
import { applySetting, cleanOrigin, type Parsed } from "./settings";

export type Io = { ask(question: string): Promise<string>; tty: boolean };

export function realIo(): { io: Io; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { io: { ask: (q) => rl.question(q), tty: !!(process.stdin.isTTY && process.stdout.isTTY) }, close: () => rl.close() };
}

const GROUP_SUFFIX = "-admins";

/** Asks for the settings that the operator can choose. An empty answer keeps the value in brackets. An invalid answer asks again. */
export async function askSettings(base: Parsed, io: Io): Promise<Parsed> {
  if (!io.tty) throw new Error("--interactive needs a terminal. Pass the settings as flags instead");
  let r: Parsed = { ...base };
  const ask = async (label: string, current: string, apply: (v: string) => Parsed, optional = false): Promise<void> => {
    let note = "";
    for (;;) {
      const answer = (await io.ask(`${note}${label}${current ? ` [${current}]` : ""}: `)).trim();
      if (answer === "" && (current || optional)) return;
      if (answer === "") {
        note = "A value is required.\n";
        continue;
      }
      try {
        r = apply(answer);
        return;
      } catch (e) {
        note = `${(e as Error).message}\n`;
      }
    }
  };
  await ask("Public URL of the hub", r.publicUrl, (v) => ({ ...r, publicUrl: cleanOrigin("public url", v) }));
  await ask("Slug of the web application", r.settings.webApp.slug, (v) => ({ ...r, settings: applySetting(r.settings, "WEB_SLUG", v) }));
  await ask("Slug of the CLI application", r.settings.cliApp.slug, (v) => ({ ...r, settings: applySetting(r.settings, "CLI_SLUG", v) }));
  await ask("Prefix of the three role groups", r.settings.adminGroup.endsWith(GROUP_SUFFIX) ? r.settings.adminGroup.slice(0, -GROUP_SUFFIX.length) : r.settings.adminGroup, (v) => ({ ...r, settings: applySetting(r.settings, "GROUP_PREFIX", v) }));
  await ask("Name of the role claim", r.settings.claim, (v) => ({ ...r, settings: applySetting(r.settings, "CLAIM", v) }));
  await ask("Name of the role scope", r.settings.scope, (v) => ({ ...r, settings: applySetting(r.settings, "SCOPE", v) }));
  await ask("Username that becomes an admin (optional)", r.settings.adminUser ?? "", (v) => ({ ...r, settings: applySetting(r.settings, "ADMIN_USER", v) }), true);
  return r;
}
