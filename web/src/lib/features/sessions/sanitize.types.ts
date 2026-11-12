// A type test. This is not a test file on purpose: `bun run --cwd web check` skips test files but checks this one.
// Plain text must not be a SafeHtml, so nothing can reach the raw HTML insert without a sanitizer. If the brand in
// sanitize.ts is removed, a line below stops being an error and the check fails with an unused directive.
import type { Formatted } from "./formatted";
import type { SafeHtml } from "./sanitize";

// @ts-expect-error a plain string is not SafeHtml
export const notSafe: SafeHtml = "<b>";
// @ts-expect-error a code result needs SafeHtml, not a string
export const notSafeCode: Formatted = { kind: "code", html: "<b>" };
// @ts-expect-error a markdown result needs SafeHtml, not a string
export const notSafeMarkdown: Formatted = { kind: "markdown", html: "<b>" };
