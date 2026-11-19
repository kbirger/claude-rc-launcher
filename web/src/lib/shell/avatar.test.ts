import { expect, test } from "vitest";
import { gravatarUrl, initials } from "./avatar";

test("initials use the first letters of the first two words", () => {
  expect(initials("Fake Dev")).toBe("FD");
  expect(initials("  ada  lovelace byron ")).toBe("AL");
  expect(initials("root")).toBe("R");
  expect(initials("  ")).toBe("?");
});

test("the Gravatar address hashes the trimmed lower-case email", async () => {
  const a = await gravatarUrl(" Dev@Example.com ", 64);
  const b = await gravatarUrl("dev@example.com", 64);
  expect(a).toBe(b);
  expect(a).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?s=64&d=404$/);
});
