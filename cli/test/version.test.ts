import { describe, expect, test } from "bun:test";
import { main, USAGE, type Env } from "../src/index";
import { VERSION } from "../../server/src/version";

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const touched: string[] = [];
  const env: Env = {
    get credsFile(): string {
      touched.push("credsFile");
      return "/nonexistent/credentials.json";
    },
    fetch: (async () => {
      touched.push("fetch");
      throw new Error("no network");
    }) as unknown as typeof fetch,
    open: async () => void touched.push("open"),
    readLine: async () => (touched.push("readLine"), ""),
  };
  return main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env).then((code) => ({ code, out, err, touched }));
}

describe("claude-rc --version", () => {
  test("prints the version without touching credentials or the hub", async () => {
    const r = await run("--version");
    expect(r).toEqual({ code: 0, out: [`claude-rc ${VERSION}`], err: [], touched: [] });
  });
  test("wins over a command and other flags", async () => {
    const r = await run("start", "/srv/x", "--hub", "https://h", "--version");
    expect(r).toEqual({ code: 0, out: [`claude-rc ${VERSION}`], err: [], touched: [] });
  });
  test("help text lists --version", () => {
    expect(USAGE).toContain("--version");
  });
});
