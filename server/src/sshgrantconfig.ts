// The text of the files of one grant on a node: the `ssh` config file and the known_hosts line.

/**
 * A path as the config file of `ssh.exe` needs it. On Linux the path stays as it is. On Windows every backslash becomes a
 * forward slash, and a path with a space gets double quotes. The reason: `ssh.exe` ignores `IdentityAgent \\.\pipe\x`
 * without a message, and then fails with a misleading `invalid format`. The forward-slash form `//./pipe/x` works.
 */
export function sshConfigPath(path: string, windows: boolean): string {
  if (!windows) return path;
  // `"` would end the quoting, a line break would end the line, and `$` starts an environment variable in some options.
  if (/["\r\n$]/.test(path)) throw new Error("a config path holds a quote, a dollar sign or a line break");
  // `%` starts a token such as %u, so it is doubled. A space, `'` or `#` needs double quotes: `#` starts a comment.
  const slashed = path.replaceAll("\\", "/").replaceAll("%", "%%");
  return /[\s'#]/.test(slashed) ? `"${slashed}"` : slashed;
}

/**
 * The lines of the config file for one target. Every value was checked: none holds a newline. `identity` is the public
 * key file of the grant: with `IdentitiesOnly yes`, ssh offers only that key of the agent, and never a default key of
 * the account that runs it (`~/.ssh/id_*`), nor a password.
 */
export function grantConfig(input: {
  targetId: string;
  address: string;
  port: number;
  account: string;
  socket: string;
  identity: string;
  knownHosts: string;
  /** The node is Windows: write the paths for `ssh.exe` (see `sshConfigPath`). */
  windows?: boolean;
}): string {
  const path = (value: string) => sshConfigPath(value, input.windows === true);

  return (
    [
      `Host ${input.targetId}`,
      `HostName ${input.address}`,
      `Port ${input.port}`,
      `User ${input.account}`,
      `IdentityAgent ${path(input.socket)}`,
      `IdentityFile ${path(input.identity)}`,
      "IdentitiesOnly yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      `UserKnownHostsFile ${path(input.knownHosts)}`,
      "GlobalKnownHostsFile /dev/null",
      "StrictHostKeyChecking yes",
      "ControlMaster no",
      "ControlPath none",
    ].join("\n") + "\n"
  );
}

/** A known_hosts line. A port other than 22 uses the `[host]:port` form. */
export function knownHostsLine(address: string, port: number, hostKey: string): string {
  return `${port === 22 ? address : `[${address}]:${port}`} ${hostKey}\n`;
}
