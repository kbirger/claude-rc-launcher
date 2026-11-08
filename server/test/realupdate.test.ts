import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { realUpdateEnv } from "../src/realupdate";
import { VERSION } from "../src/version";

describe("realUpdateEnv", () => {
  test("fills every field from the process and the configuration", () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" } as Config);
    expect(env.homes).toEqual(["/home/svc", "/root"]);
    expect(env.scope).toBe("system");
    expect(env.pathEnv).toBe(process.env.PATH ?? "");
    expect(env.execPath).toBe(process.execPath);
    expect(env.version).toBe(VERSION);
    expect([env.platform, env.arch]).toEqual([process.platform, process.arch]);
    for (const f of ["fetch", "run", "writeTemp", "removeTemp", "exists", "readFile", "realpath", "startWatchdog"] as const) expect(typeof env[f]).toBe("function");
  });

  test("run, writeTemp and removeTemp work on this machine", () => {
    const env = realUpdateEnv({ serviceHome: "/root", scope: "system" } as Config);
    expect(env.run(["sh", "-c", "echo hi; exit 3"])).toEqual({ code: 3, stdout: "hi\n", stderr: "" });
    expect(env.run(["/no/such/binary"]).code).not.toBe(0);
    const p = env.writeTemp("x", new Uint8Array([1, 2]));
    expect(Array.from(env.readFile(p))).toEqual([1, 2]);
    env.removeTemp(p);
    expect(env.exists(p)).toBe(false);
  });
});
