import { describe, expect, test } from "bun:test";
import { browserCommand } from "../src/index";

// A real authorization URL: many "&" and "%" characters.
const URL_WITH_AMPERSANDS =
  "https://auth.example.com/application/o/authorize/?response_type=code&client_id=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&scope=openid&state=s&code_challenge=x&code_challenge_method=S256";

describe("browserCommand", () => {
  test("Windows does not go through cmd, which would cut the URL at the first &", () => {
    const [cmd, args] = browserCommand("win32", URL_WITH_AMPERSANDS);
    expect(cmd.toLowerCase()).not.toBe("cmd");
    expect(cmd.toLowerCase()).not.toBe("cmd.exe");
    expect(args).not.toContain("/c");
    expect(args).not.toContain("start");
    expect(args.at(-1)).toBe(URL_WITH_AMPERSANDS); // the whole URL, as one argument
    expect(args.filter((a) => a.includes("client_id"))).toHaveLength(1);
  });

  test("macOS and the others pass the whole URL as the only argument", () => {
    expect(browserCommand("darwin", URL_WITH_AMPERSANDS)).toEqual(["open", [URL_WITH_AMPERSANDS]]);
    expect(browserCommand("linux", URL_WITH_AMPERSANDS)).toEqual(["xdg-open", [URL_WITH_AMPERSANDS]]);
  });
});
