import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExitError, credsPath, deleteCreds, loadCreds, saveCreds, type Credentials } from "../src/creds";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-creds-"));
const sample: Credentials = {
  hub: "https://rc.example.com", issuer: "https://auth.example.com/o/cli/", clientId: "cli",
  tokenEndpoint: "https://auth.example.com/o/token/", idToken: "a.b.c", refreshToken: "r", expiresAt: 1_700_000_000,
};

describe("credsPath", () => {
  test("XDG_CONFIG_HOME wins, then ~/.config, and APPDATA on win32", () => {
    expect(credsPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/a")).toBe("/x/claude-rc/credentials.json");
    expect(credsPath({}, "linux", "/home/a")).toBe("/home/a/.config/claude-rc/credentials.json");
    expect(credsPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", "C:\\Users\\a")).toBe(path.win32.join("C:\\Users\\a\\AppData\\Roaming", "claude-rc", "credentials.json"));
  });
});

describe("credentials file", () => {
  test("saveCreds writes mode 600 in a 700 directory and loadCreds round-trips", () => {
    const file = path.join(tmp(), "sub", "credentials.json");
    saveCreds(file, sample);
    expect(loadCreds(file)).toEqual(sample);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });
  test("loadCreds of a missing file is undefined", () => {
    expect(loadCreds(path.join(tmp(), "none.json"))).toBeUndefined();
  });
  test("loadCreds refuses a file that group or others can read", () => {
    if (process.platform === "win32") return;
    const file = path.join(tmp(), "c.json");
    writeFileSync(file, JSON.stringify(sample));
    chmodSync(file, 0o644);
    expect(() => loadCreds(file)).toThrow(ExitError);
    expect(() => loadCreds(file)).toThrow("chmod 600");
  });
  test("loadCreds rejects a file that is not valid credentials", () => {
    const file = path.join(tmp(), "c.json");
    writeFileSync(file, "{nope", { mode: 0o600 });
    expect(() => loadCreds(file)).toThrow("claude-rc login");
  });
  test("deleteCreds removes the file and ignores a missing one", () => {
    const file = path.join(tmp(), "c.json");
    saveCreds(file, sample);
    deleteCreds(file);
    expect(loadCreds(file)).toBeUndefined();
    deleteCreds(file);
  });
});
