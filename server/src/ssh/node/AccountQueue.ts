/**
 * Runs the work of one account one after the other. Two scripts for one account would read and rewrite the same
 * authorized_keys file, and one could lose the change of the other. A failure does not stop the next one. Accounts do
 * not wait for each other.
 */
export class AccountQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(account: string, work: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(account) ?? Promise.resolve()).catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.tails.set(account, tail);
    void tail.then(() => {
      if (this.tails.get(account) === tail) this.tails.delete(account);
    });
    return run;
  }

  /** Whether work of the account runs or waits. */
  isBusy(account: string): boolean {
    return this.tails.has(account);
  }
}
