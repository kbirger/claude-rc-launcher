import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSpawn } from "../../src/win/instances";
import { mergeEnvBlock } from "../../src/win/token";

const entries = (block: Buffer) =>
  block
    .toString("utf16le")
    .split("\0")
    .filter((item) => item !== "");

describe("mergeEnvBlock", () => {
  test("adds a variable, sorts by name and ends with two zero characters", () => {
    const block = mergeEnvBlock(["Path=C:\\x", "ComSpec=C:\\cmd.exe"], { CLAUDE_RC_SSH_TOKEN: "abc" });
    expect(entries(block)).toEqual(["CLAUDE_RC_SSH_TOKEN=abc", "ComSpec=C:\\cmd.exe", "Path=C:\\x"]);
    expect(block.subarray(block.length - 4).equals(Buffer.alloc(4))).toBe(true);
  });

  test("replaces a variable whatever the case of its name", () => {
    const block = mergeEnvBlock(["path=old", "Other=1"], { PATH: "new" });
    expect(entries(block)).toEqual(["Other=1", "PATH=new"]);
  });

  test("keeps a name that starts with an equals sign", () => {
    const block = mergeEnvBlock(["=C:=C:\\work", "A=1"], { B: "2" });
    expect(entries(block)).toEqual(["=C:=C:\\work", "A=1", "B=2"]);
  });

  test("refuses a bad name or value", () => {
    expect(() => mergeEnvBlock([], { "A=B": "x" })).toThrow();
    expect(() => mergeEnvBlock([], { "": "x" })).toThrow();
    expect(() => mergeEnvBlock([], { A: "x\0y" })).toThrow();
  });

  test("an empty list of variables still ends with two zero characters", () => {
    expect(mergeEnvBlock([], {}).equals(Buffer.alloc(4))).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32")("the plain spawn path", () => {
  test("a child sees the variables that the instance gets, and the others are kept", async () => {
    const folder = mkdtempSync(join(tmpdir(), "rc-env-"));

    try {
      const file = join(folder, "out.txt");
      const script =
        "require('node:fs').writeFileSync(process.argv[1], process.env.CLAUDE_RC_SSH_TOKEN + ':' + process.env.SystemRoot)";
      const started = bunSpawn()(process.execPath, ["-e", script, file], {
        cwd: folder,
        logFile: join(folder, "log.txt"),
        env: { CLAUDE_RC_SSH_TOKEN: "tok123" },
      });
      expect(await started.exited).toBe(0);
      expect(readFileSync(file, "utf8").trim()).toBe(`tok123:${process.env.SystemRoot}`);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
