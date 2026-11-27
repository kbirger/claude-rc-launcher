import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DROPIN_PATH, SshdDropin } from "../../server/src/ssh/node/SshdDropin";
import { FakeSshd } from "../../server/test/ssh/node/fakesshd";
import { ExitError } from "../src/creds";
import { main, type Env } from "../src/index";
import { nodeSshd } from "../src/nodesshd";
import { rejection } from "./support";

const NEW_LIST = ".ssh/authorized_keys .ssh/authorized_keys.claude-rc";

function harness(fake = new FakeSshd()) {
  const out: string[] = [];
  const err: string[] = [];
  const dropin = new SshdDropin(fake, { command: "claude-rc node sshd" });
  const call = (...args: string[]) =>
    nodeSshd({ args, out: (line) => out.push(line), err: (line) => err.push(line), dropin, platform: "linux" });
  return { fake, dropin, out, err, call };
}

describe("nodeSshd", () => {
  test("node sshd install prints the result", async () => {
    const fake = new FakeSshd();
    fake.baseList = [".ssh/authorized_keys"];
    const t = harness(fake);
    await t.call("install");
    expect(t.out).toEqual([`installed ${DROPIN_PATH}: AuthorizedKeysFile ${NEW_LIST}`, "sshd was reloaded."]);
    expect(t.err).toEqual([]);
  });

  test("node sshd as a user that is not root fails and names sudo claude-rc node sshd install", async () => {
    const fake = new FakeSshd();
    fake.root = false;
    const t = harness(fake);
    const error = await rejection(t.call("install"));
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).code).toBe(1);
    expect(t.err).toEqual(["the sshd drop-in needs root. Run: sudo claude-rc node sshd install"]);
  });

  test("node sshd check exits 1 when sshd does not read the file", async () => {
    const t = harness();
    const error = await rejection(t.call("check"));
    expect((error as ExitError).code).toBe(1);
    expect(t.out).toEqual(["sshd does not read .ssh/authorized_keys.claude-rc. Run: sudo claude-rc node sshd install"]);
  });

  test("node sshd with an unknown word prints the usage", async () => {
    for (const args of [["bogus"], [], ["install", "extra"]]) {
      const t = harness();
      const error = await rejection(t.call(...args));
      expect((error as ExitError).code).toBe(2);
      expect(t.err).toEqual(["usage: claude-rc node sshd install|check|remove"]);
      expect(t.fake.calls).toEqual([]);
    }
  });

  test("node sshd on another platform says Linux only", async () => {
    const t = harness();
    const error = await rejection(
      nodeSshd({
        args: ["check"],
        out: () => {},
        err: (line) => t.err.push(line),
        dropin: t.dropin,
        platform: "win32",
      }),
    );
    expect((error as ExitError).code).toBe(1);
    expect(t.err).toEqual(["the sshd drop-in works on Linux only"]);
  });
});

describe("claude-rc node sshd", () => {
  function run(fake: FakeSshd) {
    const credsFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-sshd-")), "none.json");
    const env: Env = {
      credsFile,
      open: async () => {},
      readLine: async () => "",
      sshdDropin: new SshdDropin(fake, { command: "claude-rc node sshd" }),
    };
    const out: string[] = [];
    const err: string[] = [];
    return async (...argv: string[]) => ({
      code: await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env),
      out,
      err,
    });
  }

  test.skipIf(process.platform !== "linux")("node sshd runs without a login", async () => {
    const fake = new FakeSshd();
    fake.baseList = [".ssh/authorized_keys", ".ssh/authorized_keys.claude-rc"];
    const result = await run(fake)("node", "sshd", "check");
    expect(result).toEqual({
      code: 0,
      out: [`sshd reads .ssh/authorized_keys.claude-rc (AuthorizedKeysFile ${NEW_LIST})`],
      err: [],
    });
  });

  test.skipIf(process.platform !== "linux")("a failed check prints its line once and exits 1", async () => {
    const result = await run(new FakeSshd())("node", "sshd", "check");
    expect(result.code).toBe(1);
    expect(result.err).toEqual([]);
    expect(result.out).toHaveLength(1);
  });

  test("node sshd refuses a flag that does not apply", async () => {
    const result = await run(new FakeSshd())("node", "sshd", "check", "--config", "x");
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("--config does not apply to node sshd");
  });
});
