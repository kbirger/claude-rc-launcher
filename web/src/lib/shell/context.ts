import { getContext, setContext } from "svelte";
import type { HostInfo } from "#lib/features/hosts";
import type { Role } from "#lib/features/auth";
import type { UpdateEntry } from "#lib/features/updates";
import type { createStartFlow } from "../startflow.svelte";

/** What the pages read from the shell: the selected host and what is known about the hosts. The shell owns it so a page change keeps it. */
export type Shell = {
  readonly flow: ReturnType<typeof createStartFlow>;
  readonly hosts: HostInfo[];
  readonly updates: UpdateEntry[];
  readonly now: Date;
  readonly user: string;
  /** The email of the user, for the avatar. Absent when the identity provider gave none or did not verify it. */
  readonly email: string | undefined;
  /** The role to show: a user with no role acts as read. Empty while the user is loading. */
  readonly role: Role | "";
  readonly logoutUrl: string;
  /** Whether the user can use a control that needs this role. The hub enforces the role: this only hides what would be refused. */
  can(need: Role): boolean;
  /** The nodes that the Sessions and Instances views show. Empty means all nodes. */
  readonly nodes: { readonly selected: string[]; toggle(id: string): void; clear(): void };
  /** True when the check for the latest release failed. */
  readonly latestError: boolean;
};

const KEY = Symbol("shell");
export const setShell = (s: Shell) => setContext(KEY, s);
export const getShell = () => getContext<Shell>(KEY);
