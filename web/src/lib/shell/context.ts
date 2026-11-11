import { getContext, setContext } from "svelte";
import type { HostInfo } from "#lib/features/hosts";
import type { UpdateEntry } from "#lib/features/updates";
import type { createStartFlow } from "../startflow.svelte";

/** What the pages read from the shell: the selected host and what is known about the hosts. The shell owns it so a page change keeps it. */
export type Shell = {
  readonly flow: ReturnType<typeof createStartFlow>;
  readonly hosts: HostInfo[];
  readonly updates: UpdateEntry[];
  readonly now: Date;
  readonly user: string;
  readonly logoutUrl: string;
  select(id: string): void;
  /** True when the check for the latest release failed. */
  readonly latestError: boolean;
};

const KEY = Symbol("shell");
export const setShell = (s: Shell) => setContext(KEY, s);
export const getShell = () => getContext<Shell>(KEY);
