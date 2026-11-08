/**
 * The Windows service runs as one account, set when the service is installed. The agent cannot change it.
 * `instance.service_user` tells the installer which account to use. At start-up the agent checks that it
 * really runs as that account, so the config cannot name one account while the trust data and the default
 * folders come from another.
 */

/** `DOMAIN\user`, `.\user` and `user` name the same local account. Windows account names ignore case. */
export function accountName(name: string): string {
  const i = name.lastIndexOf("\\");
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

export function checkServiceAccount(configured: string, running: string): void {
  if (accountName(configured) !== accountName(running)) {
    throw new Error(
      `instance.service_user is "${configured}" but this process runs as "${running}". ` +
        "Install the service to run as the account in the config, or change service_user.",
    );
  }
}
