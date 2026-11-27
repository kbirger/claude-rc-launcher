import { describe, expect, test } from "bun:test";
import { runSshdCommand } from "../../../src/ssh/node/sshdcommand";
import { DROPIN_MARKER, DROPIN_PATH, SshdDropin } from "../../../src/ssh/node/SshdDropin";
import { FakeSshd } from "./fakesshd";

const COMMAND = "claude-rc-launcher sshd-dropin";
const NEW_LIST = ".ssh/authorized_keys .ssh/authorized_keys2 .ssh/authorized_keys.claude-rc";

async function run(
  sub: string | undefined,
  fake = new FakeSshd(),
  platform: NodeJS.Platform = "linux",
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSshdCommand(sub, {
    dropin: new SshdDropin(fake, { command: COMMAND }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    platform,
  });
  return { code, out, err };
}

describe("runSshdCommand", () => {
  test("install prints the path and the list and exits 0", async () => {
    expect(await run("install")).toEqual({
      code: 0,
      out: [`installed ${DROPIN_PATH}: AuthorizedKeysFile ${NEW_LIST}`, "sshd was reloaded."],
      err: [],
    });
  });

  test("install prints the note when sshd was not reloaded", async () => {
    const fake = new FakeSshd();
    fake.reloadAnswer = { ok: false, detail: "no unit" };
    const result = await run("install", fake);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe(`installed ${DROPIN_PATH}: AuthorizedKeysFile ${NEW_LIST}`);
    expect(result.out[1]).toStartWith("sshd was not reloaded (no unit).");
    expect(result.out).toHaveLength(2);
  });

  test("install says no change when sshd reads the file already", async () => {
    const fake = new FakeSshd();
    fake.baseList = [".ssh/authorized_keys", ".ssh/authorized_keys.claude-rc"];
    expect(await run("install", fake)).toEqual({
      code: 0,
      out: ["sshd reads .ssh/authorized_keys.claude-rc already. No change."],
      err: [],
    });
  });

  test("check exits 0 and prints the list when sshd reads the file", async () => {
    const fake = new FakeSshd();
    fake.baseList = [".ssh/authorized_keys", ".ssh/authorized_keys.claude-rc"];
    expect(await run("check", fake)).toEqual({
      code: 0,
      out: [
        "sshd reads .ssh/authorized_keys.claude-rc (AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.claude-rc)",
      ],
      err: [],
    });
  });

  test("check exits 1 and names sudo claude-rc-launcher sshd-dropin install when sshd does not read the file", async () => {
    expect(await run("check")).toEqual({
      code: 1,
      out: ["sshd does not read .ssh/authorized_keys.claude-rc. Run: sudo claude-rc-launcher sshd-dropin install"],
      err: [],
    });
  });

  test("remove prints the path and the reload state, and says when there is no drop-in", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\nAuthorizedKeysFile .ssh/authorized_keys\n`);
    expect(await run("remove", fake)).toEqual({
      code: 0,
      out: [`removed ${DROPIN_PATH}`, "sshd was reloaded."],
      err: [],
    });
    expect(await run("remove", fake)).toEqual({ code: 0, out: ["no drop-in to remove"], err: [] });
  });

  test("remove prints the note when sshd was not reloaded", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\nAuthorizedKeysFile .ssh/authorized_keys\n`);
    fake.reloadAnswer = { ok: false, detail: "no unit" };
    const result = await run("remove", fake);
    expect(result.out[0]).toBe(`removed ${DROPIN_PATH}`);
    expect(result.out[1]).toStartWith("sshd was not reloaded (no unit).");
  });

  test("an error goes to err and exits 1", async () => {
    const fake = new FakeSshd();
    fake.root = false;
    expect(await run("install", fake)).toEqual({
      code: 1,
      out: [],
      err: ["the sshd drop-in needs root. Run: sudo claude-rc-launcher sshd-dropin install"],
    });
  });

  test("a machine error that is not a drop-in error also goes to err and exits 1", async () => {
    const fake = new FakeSshd();
    fake.testError = new Error("spawn failed");
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\nAuthorizedKeysFile .ssh/authorized_keys\n`);
    expect(await run("remove", fake)).toEqual({ code: 1, out: [], err: ["spawn failed"] });
  });

  test("an unknown word prints the usage and exits 2", async () => {
    const fake = new FakeSshd();

    for (const word of ["bogus", undefined]) {
      expect(await run(word, fake)).toEqual({
        code: 2,
        out: [],
        err: ["usage: claude-rc-launcher sshd-dropin install|check|remove"],
      });
    }

    expect(fake.calls).toEqual([]);
  });

  test("win32 exits 1 with the Linux only text", async () => {
    const fake = new FakeSshd();
    expect(await run("install", fake, "win32")).toEqual({
      code: 1,
      out: [],
      err: ["the sshd drop-in works on Linux only"],
    });
    expect(fake.calls).toEqual([]);
  });
});
