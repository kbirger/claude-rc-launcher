import { describe, expect, test } from "bun:test";
import { WindowsGrantPlatform } from "../../../src/ssh/node/WindowsGrantPlatform";

describe("grant platforms", () => {
  test("Windows checks the client before it sets any access list", async () => {
    const icacls: string[][] = [];
    const windows = new WindowsGrantPlatform("C:\\grants", {
      sid: "S-1-5-21-1",
      checkClient: () => Promise.resolve({ ok: false, reason: "no ssh.exe" }),
      agentTransport: () => {
        throw new Error("not used");
      },
      runIcacls: (args) => {
        icacls.push(args);
        return Promise.resolve({ code: 0, output: "" });
      },
    });

    expect(await windows.prepare("C:\\grants\\inst1")).toEqual({ ok: false, reason: "no ssh.exe" });
    expect(icacls).toEqual([]);
    expect(windows.socketFits()).toBe(true);
    expect(await windows.clientStatus()).toEqual({ ssh: false, reason: "no ssh.exe" });
  });
});
