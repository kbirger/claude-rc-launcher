import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountQueue, DEAUTHORIZE_TIMEOUT_MS, ManagedKeyError, ManagedKeyInstaller } from "../../../src/ssh/node/ManagedKeyInstaller";
import type { RunAs } from "../../../src/ssh/node/ManagedKeyInstaller";
import type { Script } from "../../../src/ssh/provision";

const LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH claude-rc:web1";
const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

async function refusal(work: Promise<unknown> | undefined): Promise<Error> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error("the work was not refused");
}

/** Lets the queued work start. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("AccountQueue", () => {
  test("work of one account runs one after the other", async () => {
    const queue = new AccountQueue();
    const order: string[] = [];
    const held = gate();

    const first = queue.run("alice", async () => {
      order.push("a start");
      await held.promise;
      order.push("a end");
    });
    const second = queue.run("alice", () => {
      order.push("b");
      return Promise.resolve();
    });
    await settle();
    expect(order).toEqual(["a start"]);

    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["a start", "a end", "b"]);
  });

  test("a failure goes to its caller and does not stop the next work", async () => {
    const queue = new AccountQueue();
    const failed = queue.run("alice", () => Promise.reject(new Error("boom")));
    const next = queue.run("alice", () => Promise.resolve("ok"));

    expect((await refusal(failed)).message).toContain("boom");
    expect(await next).toBe("ok");
  });

  test("accounts do not wait for each other", async () => {
    const queue = new AccountQueue();
    const held = gate();
    const slow = queue.run("alice", () => held.promise);

    expect(await queue.run("bob", () => Promise.resolve("bob done"))).toBe("bob done");
    held.open();
    await slow;
  });

  test("the account is no longer busy when its last work ends", async () => {
    const queue = new AccountQueue();
    const held = gate();
    const run = queue.run("alice", () => held.promise);
    expect(queue.isBusy("alice")).toBe(true);

    held.open();
    await run;
    // The cleanup runs a tick after the work.
    await settle();
    expect(queue.isBusy("alice")).toBe(false);
  });
});

describe("ManagedKeyInstaller", () => {
  let dir: string;
  let calls: { account: string; script: Script; timeoutMs: number | undefined }[];
  let answer: { code: number; stderr: string; stdout?: string };

  const runAs: RunAs = (account, script, timeoutMs) => {
    calls.push({ account, script, timeoutMs });
    return Promise.resolve(answer);
  };

  const installer = (hostKeyFile = join(dir, "host.pub")) => new ManagedKeyInstaller({ runAs, hostKeyFile });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "managedkeys-"));
    calls = [];
    answer = { code: 0, stderr: "", stdout: "removed\n" };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("authorize runs the provision script as the account with the default time limit", async () => {
    await installer().authorize({ account: "alice", systemType: "linux", line: LINE });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.account).toBe("alice");
    expect(calls[0]?.script.shell).toBe("sh");
    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  test("a script that fails for an unknown profile is a 400 with the stderr text", async () => {
    answer = { code: 1, stderr: "  no profile for account bob \n" };
    const error = await installer()
      .authorize({ account: "bob", systemType: "windows", line: LINE })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManagedKeyError);
    expect((error as ManagedKeyError).status).toBe(400);
    expect((error as ManagedKeyError).message).toBe("no profile for account bob");
  });

  test("any other failure is a 500 with the stderr text, or the exit code when stderr is empty", async () => {
    answer = { code: 2, stderr: "disk full\n" };
    expect(await refusal(installer().authorize({ account: "alice", systemType: "linux", line: LINE }))).toMatchObject({
      status: 500,
      message: "disk full",
    });

    answer = { code: 3, stderr: "  " };
    expect(await refusal(installer().authorize({ account: "alice", systemType: "linux", line: LINE }))).toMatchObject({
      status: 500,
      message: "the script exited with code 3",
    });
  });

  test("deauthorize uses its own time limit and returns the result of the script", async () => {
    answer = { code: 0, stderr: "", stdout: " not-found\n" };
    const result = await installer().deauthorize({ account: "alice", systemType: "linux", key: KEY, id: "web1" });

    expect(result).toBe("not-found");
    expect(calls[0]?.timeoutMs).toBe(DEAUTHORIZE_TIMEOUT_MS);
  });

  test("deauthorize without a known result is a 500", async () => {
    answer = { code: 0, stderr: "" };
    expect(
      await refusal(installer().deauthorize({ account: "alice", systemType: "linux", key: KEY, id: "web1" })),
    ).toMatchObject({ status: 500, message: "the script gave no result" });
  });

  test("scripts of one account wait for each other", async () => {
    const held = gate();
    const order: string[] = [];

    const slow: RunAs = async (account, script) => {
      order.push(`${account} ${script.shell} start`);
      if (order.length === 1) await held.promise;
      order.push(`${account} end`);
      return { code: 0, stderr: "", stdout: "removed" };
    };

    const queued = new ManagedKeyInstaller({ runAs: slow, hostKeyFile: join(dir, "host.pub") });

    const first = queued.authorize({ account: "alice", systemType: "linux", line: LINE });
    const second = queued.deauthorize({ account: "alice", systemType: "linux", key: KEY, id: "web1" });
    await settle();
    expect(order).toEqual(["alice sh start"]);

    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["alice sh start", "alice end", "alice sh start", "alice end"]);
  });

  test("hostKey gives the first line without its comment", async () => {
    await writeFile(join(dir, "host.pub"), `ssh-ed25519 ${KEY} root@node\nssh-rsa AAAA\n`);
    expect(await installer().hostKey()).toBe(`ssh-ed25519 ${KEY}`);
  });

  test("hostKey is a 404 for a missing file and for a key that is not Ed25519", async () => {
    expect(await refusal(installer(join(dir, "missing.pub")).hostKey())).toMatchObject({
      status: 404,
      message: "sshd has no ed25519 host key",
    });

    await writeFile(join(dir, "host.pub"), "ssh-rsa AAAA root@node\n");
    expect(await refusal(installer().hostKey())).toMatchObject({
      status: 404,
      message: "sshd has no ed25519 host key",
    });
  });
});
