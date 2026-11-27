import { describe, expect, test } from "bun:test";
import { VERSION } from "../../server/src/shared/version";
import { main, USAGE } from "../src/index";
import type { Env } from "../src/index";

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const touched: string[] = [];
  const env: Env = {
    get credsFile(): string {
      touched.push("credsFile");
      return "/nonexistent/credentials.json";
    },
    fetch: (() => {
      touched.push("fetch");
      return Promise.reject(new Error("no network"));
    }) as unknown as typeof fetch,
    open: () => Promise.resolve(void touched.push("open")),
    readLine: () => Promise.resolve((touched.push("readLine"), "")),
  };
  return main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env).then((code) => ({
    code,
    out,
    err,
    touched,
  }));
}

describe("claude-rc --version", () => {
  test("prints the version without touching credentials or the hub", async () => {
    const outcome = await run("--version");
    expect(outcome).toEqual({ code: 0, out: [`claude-rc ${VERSION}`], err: [], touched: [] });
  });
  test("wins over a command and other flags", async () => {
    const outcome = await run("start", "/srv/x", "--hub", "https://h", "--version");
    expect(outcome).toEqual({ code: 0, out: [`claude-rc ${VERSION}`], err: [], touched: [] });
  });
  test("help text lists --version", () => {
    expect(USAGE).toContain("--version");
  });
});
