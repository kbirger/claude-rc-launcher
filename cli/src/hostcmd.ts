import type { Flags } from "./args";
import { ExitError } from "./creds";
import type { HubClient } from "./hub";

/** Lower-case hex without a `sha256:` prefix or colons. */
export const normalizeFingerprint = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "")
    .replace(/:/g, "");

interface Probe {
  fingerprint: string;
  names: string[];
  subject: string;
  not_after: string;
}

/**
 * Adds a node. The hub reads the node's certificate, the user confirms it by typing the fingerprint that the node
 * printed in its own log, and only then does the hub pin it.
 */
export async function hostAdd(options: {
  id: string;
  flags: Flags;
  hub: HubClient;
  readLine: (prompt: string) => Promise<string>;
  out: (line: string) => void;
}): Promise<void> {
  const { flags } = options;
  if (!flags.url)
    throw new ExitError(
      "usage: claude-rc host add <id> --url <https-url> [--name <n>] [--server-name <n>] [--fingerprint <f>] [--force]",
      1,
    );
  const serverName = flags["server-name"];

  const probe = await options.hub.request<Probe>("POST", "/cli/api/hosts/probe", {
    url: flags.url,
    ...(serverName ? { server_name: serverName } : {}),
  });
  options.out(`Certificate presented by ${flags.url}`);
  options.out(`  subject:     ${probe.subject}`);
  options.out(`  names:       ${probe.names.join(", ")}`);
  options.out(`  expires:     ${probe.not_after}`);
  options.out(`  fingerprint: ${probe.fingerprint}`);

  const typed =
    flags.fingerprint ?? (await options.readLine("Type the fingerprint that the node printed in its log: "));

  if (normalizeFingerprint(typed) !== normalizeFingerprint(probe.fingerprint)) {
    throw new ExitError("fingerprint does not match the certificate that the node presents. Nothing was saved", 1);
  }

  await options.hub.request("POST", "/cli/api/hosts", {
    id: options.id,
    name: flags.name,
    url: flags.url,
    ...(serverName ? { server_name: serverName } : {}),
    fingerprint: `sha256:${normalizeFingerprint(typed)}`,
    ...(flags.force ? { force: true } : {}),
  });
  options.out(`added host ${options.id}`);
}

export async function hostRemove(id: string, hub: HubClient, out: (value: string) => void): Promise<void> {
  await hub.request("DELETE", `/cli/api/hosts/${encodeURIComponent(id)}`);
  out(`removed host ${id}`);
}

export async function hostRename(
  id: string,
  name: string,
  hub: HubClient,
  out: (value: string) => void,
): Promise<void> {
  await hub.request("PATCH", `/cli/api/hosts/${encodeURIComponent(id)}`, { name });
  out(`renamed host ${id} to ${name}`);
}
