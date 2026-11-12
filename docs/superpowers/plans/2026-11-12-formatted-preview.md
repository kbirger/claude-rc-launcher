# Formatted File Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The file preview of the session screens shows a markdown file rendered, and shows a code file with colors. A markdown file opens rendered, with a switch to the plain text. A code file opens wrapped, with a switch for wrapping. A file that is too large, and any other text file, shows as plain text, as today. A hostile file cannot run code on the hub origin, and it cannot make the phone load anything from another site.

**Architecture:** Six new small files in `web/src/lib/features/sessions`, each with one job. `viewkind.ts` is pure: it decides plain, markdown or code, the language and the size limits. `sanitize.ts` holds the two DOMPurify sanitizers and the `SafeHtml` type. `markdown.ts` renders markdown with `marked` and a strict renderer, and then sanitizes. `highlight.ts` colors code with `highlight.js` core and loads one grammar at a time, and then sanitizes. `formatted.ts` is the only file that imports `markdown.ts` and `highlight.ts`, and it does so by dynamic import, so they stay out of every other page. `FormattedText.svelte` is the only file in the app with a raw HTML insert, and it takes only `SafeHtml`. `FilePreview.svelte` gets the Rendered, Source and Wrap switches. `formatted.css` has the color rules and the markdown typography, and it uses only the theme variables. The server does not change.

**Tech Stack:** Svelte 5, SvelteKit with adapter-static, Tailwind, shadcn Button, Vitest (run with `bun --bun vitest`). New dependencies: `marked`, `dompurify`, `highlight.js` (dependencies) and `jsdom` (dev dependency, for the DOM in tests). Playwright is already installed for the browser check.

**Spec:** `docs/superpowers/specs/2026-11-12-formatted-preview-design.md`. It is binding. The code is on `feat/formatted-preview`, based on `main` at `4412ce4` plus the design commit `eca3246`.

## Global Constraints

1. The design is binding. The decisions in it are not open for change: `marked` with raw HTML escaped, images shown as text and never loaded, only `http`, `https` and `mailto` links kept, DOMPurify with a fixed list as the second layer, `highlight.js` core with 15 grammars loaded by dynamic import, its output also sanitized, limits of 256 K characters for markdown and 128 K characters for colors, a Rendered or Source switch for markdown, a Wrap switch for code, a failed render falls back to plain text with no error page.
2. The limits count characters of the text string (`text.length`), not bytes. The note on screen and the docs say so. K means 1,024.
3. The only raw HTML insert in the app lives in `FormattedText.svelte`, exactly once. `rawhtml.test.ts` (Task 5) fails if it lives anywhere else or twice. Never write `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in app code. Never write the raw HTML insert in a comment of another file, because the test counts the text.
4. Every security claim is proven by a test with hostile input. A test reads the output as a browser would (`DOMParser`) and checks tags and attributes. It does not search for substrings. Do not weaken a test to make it pass. If a payload fails, fix the renderer or the sanitizer.
5. The DOM for tests is `jsdom`, not `happy-dom`. In happy-dom, DOMPurify keeps a `<script>` tag (measured on happy-dom 21), so a green test there proves nothing. `domenv.test.ts` (Task 1) guards this. A test file picks the DOM with `// @vitest-environment jsdom` as its first line. The default test environment stays as it is, and the existing tests do not change.
6. The libraries load only on the preview page. `FilePreview.svelte` and everything it imports statically may import only `viewkind.ts`, `formatted.ts` and `FormattedText.svelte`. Only `formatted.ts` imports `markdown.ts` and `highlight.ts`, and only by `import()`. Only `markdown.ts`, `highlight.ts` and `sanitize.ts` import `marked`, `dompurify` and `highlight.js`. `FormattedText.svelte` and `formatted.ts` import `SafeHtml` as a type only (`import type`).
7. The feature folder rule stays. Nothing outside `features/sessions` imports these files. `index.ts` does not change. `format.ts` and `format.test.ts` do not change either, because the new pure code lives in `viewkind.ts`.
8. Dependencies go only in `web/package.json`, and `web/bun.lock` is committed. The root `bun.lock` does not change. CI runs `bun install --frozen-lockfile` in the root and in `web`.
9. Run every command with `export PATH=$HOME/.bun/bin:$PATH` first. Each step names the folder. Web tests run as `cd web && bun --bun vitest run <path>`. The full checks are `bun test server ./cli`, `bun run typecheck`, `bun run --cwd web check` and `cd web && bun --bun vitest run src`, all from the repo root unless a `cd` is shown.
10. The web build writes to `web/dist`. It is ignored by git.
11. One task, one commit. Tests are green after every task. Test first: write the test, run it and see it fail for the right reason, then write the code and see it pass.
12. Documents and comments use plain English: short sentences, no contractions, no semicolons, no em-dashes, the condition before the command.
13. Do not change any file that this plan does not name. Do not commit screenshots.
14. The test baseline is whatever `cd web && bun --bun vitest run src` reports before Task 1. Write that number in the commit message of Task 1. The number of tests must never drop.

## Review Focus

Each item names a way that this feature can still hurt, and the test or check that pins it.

- **A sanitizer config that is too loose.** `sanitize.ts` has a fixed tag list (`MARKDOWN_TAGS`), only `href` and `title` as attributes, an address filter that allows only `http:`, `https:` and `mailto:`, and no data or aria attributes. A change that adds `class`, `style`, `img`, `svg`, `input`, `details` or `id` must fail a test. `sanitize.test.ts` feeds 24 raw hostile HTML strings straight to the sanitizer and checks every element and attribute of the parsed result. `markdown.test.ts` checks the allow-list for the whole corpus.
- **Markdown that renders to a clickable bad link.** The renderer keeps an address only if the raw text starts with `http://`, `https://` or `mailto:` (`safeHref`). An entity form, a percent form, upper case, a leading space, a tab or a control character in the scheme does not start with that text, so it is refused before DOMPurify sees it. The corpus has every link form: inline, reference, collapsed, shortcut, autolink, angle brackets, image, table cell, footnote, task list. Each is checked twice: for the renderer alone (layer 1) and for the full result (both layers). Layer 1 must be safe without layer 2. A reviewer should read `safeHref` and its test with the most care.
- **A large file that freezes the page.** The limits (256 K and 128 K characters) are in `viewkind.ts` and are tested at the exact edge. A larger file never loads a library. `markdown.test.ts` has a 256 KB timing test and deep nesting payloads (2000 nested quotes, 5000 open brackets, 5000 open tags). A render that throws (for example a stack overflow) gives `undefined`, and the preview shows plain text. Measured in jsdom (about ten times slower than a browser), DOMPurify needs about 1.1 seconds for a 256 KB markdown file and marked needs 75 ms. In a real browser with the CPU slowed 4 times, a 250 KB markdown file opened in about 4.4 seconds in total (load included). The Task 6 check records this time. If a reviewer finds it too slow for a phone, the fix is a lower `MARKDOWN_LIMIT` in `viewkind.ts`, and the docs and tests follow that one constant.
- **The dynamic imports that fail offline.** `formatted.ts` catches a failed import and gives plain text with a note. `formatted.test.ts` and `highlightfail.test.ts` pin this. The grammar loads in `highlightCode`, inside its `try`.
- **The bundle growing for every page.** Task 1 checks that the build contains none of the library code before anything imports it. Task 6 loads the sessions list page in a real browser and checks that no JavaScript file it loads contains `ALLOWED_TAGS` (DOMPurify), `walkTokens` (marked) or `registerLanguage` (highlight.js). Also read the build output list in Task 5: the library chunks must be separate files.
- **`{@html` creeping elsewhere.** `rawhtml.test.ts` scans every app source file for the raw HTML insert and the other HTML sinks, and expects exactly one hit, in `FormattedText.svelte`. `FormattedText.test.ts` passes the output of the real renderers through the component and checks the live page for scripts, images, frames and handlers.
- **Dark mode contrast.** The color rules use only theme variables. The Task 6 script computes the contrast of the six code colors against the code box in all four palettes (light, dark, Ayu, Tokyo Night) and requires at least 4.5. The light theme `--warn` is only 4.2, so `--tok-number` mixes it with the text color. The screenshots must also be read by a person.
- **A failed render.** A render that gives `undefined`, a throw, or a failed import all end in plain text and a short note (`FAILED_NOTE`). No error page, no console error. Task 6 asserts no console error.
- **A table that makes the page scroll sideways.** `.formatted-md table` is `display: block` with `overflow-x: auto`, and its cells do not break inside words, so a wide table scrolls in its own box. Task 6 asserts that the table scrolls and that the page does not.

## File structure

All paths are under `web/src/lib/features/sessions` unless a full path is given.

| File | Status | One job |
| --- | --- | --- |
| `viewkind.ts` | Create | Pure. The extension and name map, the two size limits, the note text, and `viewKind`, which decides plain, markdown or code. No DOM, no libraries. |
| `viewkind.test.ts` | Create | Tests of `viewkind.ts`. |
| `sanitize.ts` | Create | The two DOMPurify sanitizers and the `SafeHtml` type. The only file that makes `SafeHtml`. |
| `sanitize.test.ts` | Create | Feeds raw hostile HTML to the sanitizers. |
| `markdown.ts` | Create | The `marked` renderer (layer 1), `safeHref`, and `renderMarkdown` (both layers). |
| `markdown.test.ts` | Create | The hostile corpus (more than 80 payloads), the renderer checks and the limits. |
| `highlight.ts` | Create | highlight.js core, the 15 lazy grammar loaders, and `highlightCode`. |
| `highlight.test.ts` | Create | Grammars, hostile source text, the time for 128 KB. |
| `highlightfail.test.ts` | Create | A grammar that fails to load. Its own file, because a registered grammar stays registered in a file. |
| `formatted.ts` | Create | `formatText`: picks the view with `viewKind`, loads the library by `import()`, and falls back to plain. |
| `formatted.test.ts` | Create | Tests of `formatText` with fake loaders. |
| `FormattedText.svelte` | Create | The only raw HTML insert in the app. Takes `SafeHtml`. |
| `FormattedText.test.ts` | Create | Mounts the component with real renderer output and checks the live page. |
| `formatted.css` | Create | Code color rules, markdown typography, and the table box. Theme variables only. |
| `domenv.test.ts` | Create | Guards the DOM environment: DOMPurify must remove a script tag. |
| `FilePreview.svelte` | Modify | Calls `formatText`, shows the Rendered, Source and Wrap switches, the note, and the `data-preview` marks. |
| `web/src/lib/rawhtml.test.ts` | Create | The raw HTML insert exists in exactly one file. |
| `web/package.json`, `web/bun.lock` | Modify | The new dependencies. |
| `README.md`, `docs/session-files.md` | Modify | The user guide and the code guide. |
| `/tmp/fpcheck/check.ts` | Throwaway, not in the repo | The real browser check of Task 6. |

## Interfaces

These are the exact names and types. Later tasks use them as written here.

```ts
// viewkind.ts
export const MARKDOWN_LIMIT = 262144;   // 256 * 1024 characters
export const CODE_LIMIT = 131072;       // 128 * 1024 characters
export const LANGUAGES: readonly ["typescript", "javascript", "json", "python", "bash", "yaml", "xml", "css", "sql", "go", "rust", "ini", "diff", "dockerfile", "makefile"];
export type LanguageId = (typeof LANGUAGES)[number];
export type ViewPlan = { kind: "markdown" } | { kind: "code"; language: LanguageId } | { kind: "plain"; note?: string };
export function languageFor(name: string): LanguageId | undefined;
export const isMarkdownName: (name: string) => boolean;
export function viewKind(name: string, length: number): ViewPlan;   // length is text.length

// sanitize.ts (browser only: it uses `window`)
export type SafeHtml = string & { readonly [safe]: true };
export const MARKDOWN_TAGS: readonly string[];
export const sanitizeMarkdownHtml: (html: string) => SafeHtml;
export const sanitizeCodeHtml: (html: string) => SafeHtml;

// markdown.ts
export function safeHref(href: string | null | undefined): string | undefined;
export const markdownToHtml: (text: string) => string;            // layer 1 only, for tests
export function renderMarkdown(text: string): SafeHtml | undefined; // undefined when anything throws

// highlight.ts
export const grammarLoaders: Record<LanguageId, () => Promise<{ default: LanguageFn }>>;   // LanguageFn from "highlight.js"
export function highlightCode(text: string, language: LanguageId): Promise<SafeHtml | undefined>;

// formatted.ts
export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "code"; html: SafeHtml } | { kind: "plain"; note?: string };
export type Loaders = { markdown: () => Promise<typeof import("./markdown")>; highlight: () => Promise<typeof import("./highlight")> };
export const FAILED_NOTE = "This file could not be formatted. It shows as plain text.";
export function formatText(name: string, text: string, loaders?: Loaders): Promise<Formatted>;   // never rejects

// FormattedText.svelte props
type Props = { kind: "markdown" | "code"; html: SafeHtml; wrap?: boolean };   // wrap defaults to true
```

Marks that the browser check reads (Task 5 creates them, Task 6 uses them):

- `data-preview="rendered"` (rendered markdown), `"source"` (markdown source), `"code"` (colored code), `"plain"` (plain text), `"binary"` (not text).
- `.formatted-md` (the rendered markdown box) and `.formatted-code` (the code box, with the extra class `nowrap` when wrapping is off).
- Buttons with the visible text `Rendered`, `Source` and `Wrap`. Each has `aria-pressed`.

## Task 1: Dependencies and the DOM test environment

**Files:**
- Modify: `web/package.json`, `web/bun.lock`
- Create: `web/src/lib/features/sessions/domenv.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the test first.** Create `web/src/lib/features/sessions/domenv.test.ts`. Its first line selects the DOM. It guards the choice of `jsdom`.

````ts
// @vitest-environment jsdom
import createDOMPurify from "dompurify";
import { expect, test } from "vitest";

// This file guards the choice of jsdom. In happy-dom, DOMPurify keeps a script tag. If this test fails after a package
// change, the sanitizer tests below cannot be trusted.
test("the DOM environment has a real HTML parser and DOMPurify works in it", () => {
  expect(typeof DOMParser).toBe("function");
  const purify = createDOMPurify(window);
  expect(purify.isSupported).toBe(true);
  expect(purify.sanitize("x<script>1</script>")).toBe("x");
  expect(purify.sanitize("<b onclick=\"1\">y</b>")).toBe("<b>y</b>");
});
````

- [ ] **Step 2: Record the baseline and see the test fail.** Run `export PATH=$HOME/.bun/bin:$PATH && cd web && bun --bun vitest run src 2>&1 | tail -8`. Write down the `Tests` count. The new test file fails because `dompurify` and `jsdom` are not installed. That is the expected failure.
- [ ] **Step 3: Add the dependencies.** Run these two commands in the `web` folder, in this order:

```bash
export PATH=$HOME/.bun/bin:$PATH
cd web
bun add marked dompurify highlight.js
bun add -d jsdom
```

  Open `web/package.json`. `marked`, `dompurify` and `highlight.js` must be under `dependencies`. `jsdom` must be under `devDependencies`. The versions that `bun add` wrote at the time of this plan are `marked ^18.2.0`, `dompurify ^3.4.17`, `highlight.js ^11.12.0` and `jsdom ^31.0.0`. Keep what `bun add` writes. Do not add `happy-dom`. Do not add `@types/dompurify`, because `dompurify` ships its own types.
- [ ] **Step 4: Run the DOM test.** Run `cd web && bun --bun vitest run src/lib/features/sessions/domenv.test.ts`. It passes. If it fails on the `<script>` check, stop and report. Do not change the test.
- [ ] **Step 5: Check the lock file is consistent.** Run these, and each must print `no changes`:

```bash
export PATH=$HOME/.bun/bin:$PATH
(cd web && bun install --frozen-lockfile 2>&1 | tail -2)
bun install --frozen-lockfile 2>&1 | tail -2
git status --short
```

  `git status` must list only `web/package.json`, `web/bun.lock` and the new test file (plus the files that were already untracked before: `.oidc/`, `.serena/`, `HANDOVER.md`, `run.sh`). The root `bun.lock` must not appear.
- [ ] **Step 6: Check that the production build still works and does not contain the libraries yet.** Nothing imports them, so the build must not include them.

```bash
export PATH=$HOME/.bun/bin:$PATH
bun run --cwd web build 2>&1 | tail -4
grep -rl "ALLOWED_TAGS\|walkTokens\|registerLanguage" web/dist || echo "libraries not in the build (expected)"
```

  The build ends with `done`. The grep finds nothing.
- [ ] **Step 7: Run the checks.** `bun run --cwd web check` has 0 errors. `cd web && bun --bun vitest run src` is green, with one more test file than the baseline.
- [ ] **Step 8: Commit.**

```bash
git add web/package.json web/bun.lock web/src/lib/features/sessions/domenv.test.ts
git commit -m "build(web): add marked, dompurify, highlight.js and a jsdom test environment"
```

## Task 2: The pure view decision

**Files:**
- Create: `web/src/lib/features/sessions/viewkind.ts`, `web/src/lib/features/sessions/viewkind.test.ts`

**Interfaces:** `MARKDOWN_LIMIT`, `CODE_LIMIT`, `LANGUAGES`, `LanguageId`, `ViewPlan`, `languageFor`, `isMarkdownName`, `viewKind` (see Interfaces).

- [ ] **Step 1: Write the test first.** Create `viewkind.test.ts`. It has no DOM line, because the code is pure.

````ts
import { describe, expect, test } from "vitest";
import { CODE_LIMIT, LANGUAGES, MARKDOWN_LIMIT, isMarkdownName, languageFor, viewKind } from "./viewkind";

describe("languageFor", () => {
  test("picks the grammar by extension, without case", () => {
    expect(languageFor("a.ts")).toBe("typescript");
    expect(languageFor("A.TSX")).toBe("typescript");
    expect(languageFor("a.mjs")).toBe("javascript");
    expect(languageFor("a.jsonc")).toBe("json");
    expect(languageFor("run.SH")).toBe("bash");
    expect(languageFor("a.yml")).toBe("yaml");
    expect(languageFor("page.svelte")).toBe("xml");
    expect(languageFor("a.toml")).toBe("ini");
    expect(languageFor("fix.patch")).toBe("diff");
    expect(languageFor("main.rs")).toBe("rust");
    expect(languageFor("main.go")).toBe("go");
  });
  test("picks Dockerfile and Makefile by name", () => {
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("dockerfile")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBe("makefile");
    expect(languageFor("GNUmakefile")).toBe("makefile");
    expect(languageFor("rules.mk")).toBe("makefile");
  });
  test("uses the last name of a path with / or \\", () => {
    expect(languageFor("src/lib/a.ts")).toBe("typescript");
    expect(languageFor("C:\\proj\\Makefile")).toBe("makefile");
  });
  test("gives undefined for an unknown name, a hidden file with no extension, and names that match object keys", () => {
    for (const n of ["notes.txt", "LICENSE", "", "a.", ".gitignore", "constructor", "x.constructor", "toString", "x.__proto__", "x.hasOwnProperty"]) expect(languageFor(n), n).toBeUndefined();
  });
  test("every language that an extension maps to is in LANGUAGES, and LANGUAGES has 15 entries", () => {
    expect(LANGUAGES.length).toBe(15);
    expect(new Set(LANGUAGES).size).toBe(15);
  });
});

describe("isMarkdownName", () => {
  test("accepts .md and .markdown without case", () => {
    for (const n of ["README.md", "a.MD", "notes.markdown", "docs/a.Md"]) expect(isMarkdownName(n), n).toBe(true);
  });
  test("refuses other names", () => {
    for (const n of ["md", "a.mdx", "a.md.txt", "a.mdc", ""]) expect(isMarkdownName(n), n).toBe(false);
  });
});

describe("viewKind", () => {
  test("markdown, code and plain", () => {
    expect(viewKind("README.md", 10)).toEqual({ kind: "markdown" });
    expect(viewKind("a.ts", 10)).toEqual({ kind: "code", language: "typescript" });
    expect(viewKind("notes.txt", 10)).toEqual({ kind: "plain" });
  });
  test("an empty file is still markdown or code", () => {
    expect(viewKind("a.md", 0)).toEqual({ kind: "markdown" });
    expect(viewKind("a.go", 0)).toEqual({ kind: "code", language: "go" });
  });
  test("the limits count characters and are inclusive", () => {
    expect(MARKDOWN_LIMIT).toBe(262144);
    expect(CODE_LIMIT).toBe(131072);
    expect(viewKind("a.md", MARKDOWN_LIMIT).kind).toBe("markdown");
    expect(viewKind("a.md", MARKDOWN_LIMIT + 1).kind).toBe("plain");
    expect(viewKind("a.ts", CODE_LIMIT).kind).toBe("code");
    expect(viewKind("a.ts", CODE_LIMIT + 1).kind).toBe("plain");
  });
  test("a markdown file between the two limits is still markdown", () => {
    expect(viewKind("a.md", CODE_LIMIT + 1).kind).toBe("markdown");
  });
  test("a too large file has a note that names the limit and says characters", () => {
    const md = viewKind("a.md", MARKDOWN_LIMIT + 1);
    const code = viewKind("a.ts", CODE_LIMIT + 1);
    expect(md).toEqual({ kind: "plain", note: "This file has more than 256 K characters (K is 1,024), which is too many to format. It shows as plain text." });
    expect(code).toEqual({ kind: "plain", note: "This file has more than 128 K characters (K is 1,024), which is too many to format. It shows as plain text." });
  });
  test("a large file of an unknown type has no note", () => {
    expect(viewKind("big.txt", MARKDOWN_LIMIT * 2)).toEqual({ kind: "plain" });
  });
});
````

- [ ] **Step 2: See it fail.** Run `cd web && bun --bun vitest run src/lib/features/sessions/viewkind.test.ts`. It fails because `./viewkind` does not exist.
- [ ] **Step 3: Write `viewkind.ts`.** Use this code exactly. The 15 ids are the file names under `highlight.js/lib/languages`. Task 4 depends on that. `Object.hasOwn` stops a name such as `constructor` from matching an object key.

````ts
// Decides how the preview shows a text file. Pure: no DOM, no libraries, so the preview page can import it without
// loading the markdown or color code. The grammar ids are the file names under highlight.js/lib/languages.

/** Largest text, in characters of the string (not bytes), that is rendered as markdown. 256 K, where K is 1024. */
export const MARKDOWN_LIMIT = 256 * 1024;
/** Largest text, in characters of the string (not bytes), that gets code colors. 128 K, where K is 1024. */
export const CODE_LIMIT = 128 * 1024;

export const LANGUAGES = ["typescript", "javascript", "json", "python", "bash", "yaml", "xml", "css", "sql", "go", "rust", "ini", "diff", "dockerfile", "makefile"] as const;
export type LanguageId = (typeof LANGUAGES)[number];

export type ViewPlan = { kind: "markdown" } | { kind: "code"; language: LanguageId } | { kind: "plain"; note?: string };

const BY_EXTENSION: Record<string, LanguageId> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", jsonc: "json",
  py: "python",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
  html: "xml", htm: "xml", xhtml: "xml", xml: "xml", svg: "xml", svelte: "xml", vue: "xml",
  css: "css",
  sql: "sql",
  go: "go",
  rs: "rust",
  ini: "ini", toml: "ini", cfg: "ini",
  diff: "diff", patch: "diff",
  dockerfile: "dockerfile",
  mk: "makefile",
};
const BY_NAME: Record<string, LanguageId> = { dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile" };
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** The last name of a path. Both "/" and "\\" separate names. */
const lastName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

/** The grammar for a file name, or undefined. The whole name is tried first (Dockerfile, Makefile), then the extension. */
export function languageFor(name: string): LanguageId | undefined {
  const base = lastName(name).toLowerCase();
  if (Object.hasOwn(BY_NAME, base)) return BY_NAME[base];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1);
  return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : undefined;
}

export const isMarkdownName = (name: string): boolean => {
  const base = lastName(name).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 && MARKDOWN_EXTENSIONS.has(base.slice(dot + 1));
};

const tooLarge = (limit: number): string => `This file has more than ${limit / 1024} K characters (K is 1,024), which is too many to format. It shows as plain text.`;

/** How to show the text of a file: rendered markdown, colored code, or plain. `length` is `text.length`. */
export function viewKind(name: string, length: number): ViewPlan {
  if (isMarkdownName(name)) return length <= MARKDOWN_LIMIT ? { kind: "markdown" } : { kind: "plain", note: tooLarge(MARKDOWN_LIMIT) };
  const language = languageFor(name);
  if (language === undefined) return { kind: "plain" };
  return length <= CODE_LIMIT ? { kind: "code", language } : { kind: "plain", note: tooLarge(CODE_LIMIT) };
}
````

- [ ] **Step 4: See it pass.** Run the same test command. All tests pass.
- [ ] **Step 5: Run the checks.** `bun run --cwd web check` has 0 errors. `cd web && bun --bun vitest run src` is green.
- [ ] **Step 6: Commit.**

```bash
git add web/src/lib/features/sessions/viewkind.ts web/src/lib/features/sessions/viewkind.test.ts
git commit -m "feat(web): decide plain, markdown or code for a preview, with size limits"
```

## Task 3: The sanitizers, the markdown renderer and the hostile corpus

**Files:**
- Create: `sanitize.ts`, `sanitize.test.ts`, `markdown.ts`, `markdown.test.ts` (all in `web/src/lib/features/sessions`)

**Interfaces:** `SafeHtml`, `MARKDOWN_TAGS`, `sanitizeMarkdownHtml`, `sanitizeCodeHtml`, `safeHref`, `markdownToHtml`, `renderMarkdown`.

The design has two layers. Layer 1 is the `marked` renderer. It escapes raw HTML, shows an image as a text link (the text is `Image: ` and the alt text), keeps only `http`, `https` and `mailto` links, shows a task list mark as text (`[x] ` or `[ ] `), and writes a code block with no `class`. Layer 2 is DOMPurify with a fixed list. Two facts that were measured and that the code relies on:

- `marked` leaves an HTML entity in a link address, such as `java&#115;cript:`. A browser decodes it. So `safeHref` must test the raw text with a start-anchored pattern, and it must never decode first.
- DOMPurify with `ALLOWED_ATTR` that includes `align` still drops `align`. So table alignment is not kept. Do not add it back.

- [ ] **Step 1: Write the sanitizer test first.** Create `sanitize.test.ts`.

````ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { sanitizeCodeHtml, sanitizeMarkdownHtml } from "./sanitize";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("sanitizeMarkdownHtml (second layer, fed raw hostile HTML)", () => {
  const HOSTILE = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<svg onload=alert(1)>", "<iframe src=javascript:alert(1)></iframe>",
    "<a href=\"javascript:alert(1)\">x</a>", "<a href=\"JaVaScRiPt:alert(1)\">x</a>", "<a href=\"java&#115;cript:alert(1)\">x</a>",
    "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>", "<a href=\"vbscript:msgbox(1)\">x</a>", "<a href=\"/relative\">x</a>",
    "<a href=\"https://ok.example\" onclick=\"alert(1)\" style=\"x:y\" class=\"c\" id=\"i\" data-x=\"1\">x</a>",
    "<p style=\"background:url(https://evil.example)\" class=\"hljs-keyword\">x</p>", "<form action=x><input name=a><button formaction=javascript:alert(1)>b</button></form>",
    "<style>*{x:y}</style>", "<meta http-equiv=refresh content=\"0;url=https://evil.example\">", "<base href=\"https://evil.example/\">",
    "<math><mi xlink:href=\"data:x,<script>alert(1)</script>\"></mi></math>", "<object data=\"javascript:alert(1)\"></object>", "<embed src=\"javascript:alert(1)\">",
    "<details open ontoggle=alert(1)><summary>s</summary>t</details>", "<input type=checkbox checked disabled>", "<video src=x onerror=alert(1)></video>",
    "<a href=\"https://ok.example\" target=\"_self\" rel=\"opener\">x</a>", "<table><tr><td align=\"left\" onclick=\"alert(1)\">x</td></tr></table>",
  ];
  for (const [i, html] of HOSTILE.entries()) {
    test(`payload ${i}`, () => {
      const out = doc(sanitizeMarkdownHtml(html));
      for (const el of Array.from(out.body.querySelectorAll("*"))) {
        const tag = el.tagName.toLowerCase();
        expect(["script", "img", "svg", "math", "iframe", "form", "input", "button", "style", "meta", "base", "object", "embed", "video", "details", "summary"]).not.toContain(tag);
        for (const a of Array.from(el.attributes)) {
          expect(a.name.startsWith("on")).toBe(false);
          expect(["style", "class", "id", "src", "srcdoc", "formaction"]).not.toContain(a.name);
          expect(a.name.startsWith("data-")).toBe(false);
        }
        if (tag === "a") {
          expect(el.getAttribute("href") ?? "https://ok.example").toMatch(/^(https?:|mailto:)/i);
          expect(el.getAttribute("target")).toBe("_blank");
          expect(el.getAttribute("rel")).toBe("noopener noreferrer nofollow");
        }
      }
    });
  }
  test("keeps the allowed tags and adds target and rel to links", () => {
    const out = doc(sanitizeMarkdownHtml("<h1>t</h1><p><a href=\"https://ok.example/x\" title=\"T\">l</a></p><table><tbody><tr><td align=\"right\" class=\"x\">c</td></tr></tbody></table>"));
    expect(out.querySelector("h1")?.textContent).toBe("t");
    const a = out.querySelector("a")!;
    expect([a.getAttribute("href"), a.getAttribute("title"), a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["https://ok.example/x", "T", "_blank", "noopener noreferrer nofollow"]);
    expect(out.querySelector("td")?.textContent).toBe("c");
    expect(out.querySelector("td")?.hasAttribute("align")).toBe(false);
  });
  test("keeps mailto links", () => {
    expect(doc(sanitizeMarkdownHtml("<a href=\"mailto:a@b.example\">m</a>")).querySelector("a")?.getAttribute("href")).toBe("mailto:a@b.example");
  });
});

describe("sanitizeCodeHtml", () => {
  test("keeps span and class and nothing else", () => {
    const out = doc(sanitizeCodeHtml("<span class=\"hljs-keyword\" onclick=\"1\" style=\"x:y\">a</span><a href=\"https://ok.example\">l</a><img src=x onerror=1><script>1</script>"));
    expect(Array.from(out.body.querySelectorAll("*")).map((e) => e.tagName.toLowerCase())).toEqual(["span"]);
    const s = out.querySelector("span")!;
    expect(Array.from(s.attributes).map((a) => a.name)).toEqual(["class"]);
    expect(s.className).toBe("hljs-keyword");
  });
});
````

- [ ] **Step 2: Write the markdown test first.** Create `markdown.test.ts`. It has more than 80 payloads. Each runs two tests: the renderer alone (layer 1) and the full result. The `problems` function reads the HTML with `DOMParser`, and it lists every tag outside the allow-list, every attribute outside the allow-list, every `on*` attribute, every `style`, every `src`, every link address that does not start with `http:`, `https:` or `mailto:`, and (for the full result) every link without `target="_blank"` and `rel="noopener noreferrer nofollow"`. An image is a disallowed tag, so `<img` is covered. Keep the payload list as it is. You may add payloads. You may not remove or weaken one.

````ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { markdownToHtml, renderMarkdown, safeHref } from "./markdown";

const TAGS = new Set(["a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "table", "thead", "tbody", "tr", "th", "td"]);
const ATTRS: Record<string, string[]> = { a: ["href", "title", "target", "rel"], th: ["align"], td: ["align"] };

/** Reads the HTML as a browser would and lists every problem. `final` is false for the output of layer 1 alone, which has no target and rel yet. */
function problems(html: string, final: boolean): string[] {
  const out: string[] = [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (!TAGS.has(tag)) out.push(`tag ${tag}`);
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("on")) out.push(`handler ${a.name}`);
      if (a.name === "style") out.push("style");
      if (a.name === "src") out.push("src");
      if (!(ATTRS[tag] ?? []).includes(a.name)) out.push(`attribute ${tag}.${a.name}`);
      if (!final && (a.name === "target" || a.name === "rel")) out.push(`attribute ${tag}.${a.name} before layer 2`);
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) out.push(`href ${href}`);
      if (final && (el.getAttribute("target") !== "_blank" || el.getAttribute("rel") !== "noopener noreferrer nofollow")) out.push("link target or rel");
    }
  }
  return out;
}

const PAYLOADS: Record<string, string> = {
  script: "<script>alert(1)</script>",
  scriptInline: "text <script>alert(1)</script> text",
  scriptUpper: "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  onerrorImg: "<img src=x onerror=alert(1)>",
  onloadSvg: "<svg onload=alert(1)>",
  onclickAttr: "<a href=\"https://ok.example\" onclick=\"alert(1)\">x</a>",
  onmouseover: "<p onmouseover=alert(1)>hover</p>",
  inlineLink: "[x](javascript:alert(1))",
  inlineLinkCase: "[x](JaVaScRiPt:alert(1))",
  inlineLinkSpace: "[x](  javascript:alert(1))",
  inlineLinkAngle: "[x](<javascript:alert(1)>)",
  inlineLinkEntity: "[x](java&#115;cript:alert(1))",
  inlineLinkEntityHex: "[x](&#x6A;avascript:alert(1))",
  inlineLinkEntityColon: "[x](javascript&colon;alert(1))",
  inlineLinkPercent: "[x](javascript%3Aalert(1))",
  inlineLinkTab: "[x](java\tscript:alert(1))",
  inlineLinkNewline: "[x](java\nscript:alert(1))",
  inlineLinkControl: "[x](\u0001javascript:alert(1))",
  inlineLinkNul: "[x](java\u0000script:alert(1))",
  dataLink: "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  dataLinkUpper: "[x](DATA:text/html,<script>alert(1)</script>)",
  vbscript: "[x](vbscript:msgbox(1))",
  vbscriptMixed: "[x](VbScRiPt:msgbox(1))",
  fileLink: "[x](file:///etc/passwd)",
  relativeLink: "[x](../secret.md)",
  protocolRelative: "[x](//evil.example/x)",
  refLink: "[x][1]\n\n[1]: javascript:alert(1)",
  refLinkCollapsed: "[x][]\n\n[x]: javascript:alert(1)",
  refLinkShortcut: "[x]\n\n[x]: data:text/html,hi",
  autolink: "<javascript:alert(1)>",
  autolinkMail: "<a@b.example>",
  autolinkBare: "www.evil.example/x and https://ok.example/a_b",
  imgOnerror: "![x](x \"t\" onerror=alert(1))",
  imgJs: "![x](javascript:alert(1))",
  imgRemote: "![tracker](https://evil.example/pixel.png)",
  imgRef: "![x][1]\n\n[1]: https://evil.example/p.png",
  imgData: "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  svg: "<svg><script>alert(1)</script></svg>",
  svgUse: "<svg><use href=\"data:image/svg+xml,<svg id='x' xmlns='http://www.w3.org/2000/svg'><image href='1' onerror='alert(1)'/></svg>#x\"/></svg>",
  math: "<math><mi//xlink:href=\"data:x,<script>alert(1)</script>\">",
  iframe: "<iframe src=\"javascript:alert(1)\"></iframe>",
  iframeSrcdoc: "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
  object: "<object data=\"javascript:alert(1)\"></object><embed src=\"javascript:alert(1)\">",
  form: "<form action=\"https://evil.example\"><input name=p><button>go</button></form>",
  formaction: "<button formaction=\"javascript:alert(1)\">x</button>",
  style: "<style>*{background:url(https://evil.example/t)}</style>",
  styleAttr: "<p style=\"background:url(https://evil.example/t)\">x</p>",
  metaRefresh: "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">",
  base: "<base href=\"https://evil.example/\">[x](a)",
  linkTag: "<link rel=stylesheet href=\"https://evil.example/x.css\">",
  htmlComment: "<!-- <script>alert(1)</script> -->",
  htmlCommentBroken: "<!--><script>alert(1)</script>-->",
  cdata: "<![CDATA[<script>alert(1)</script>]]>",
  nestedBroken: "<div><p><b><i>x</div></p></b></i><script>alert(1)",
  nestedBrokenTag: "<scr<script>ipt>alert(1)</scr</script>ipt>",
  unclosed: "<a href=\"https://ok.example\" title=\"x><script>alert(1)</script>",
  details: "<details open ontoggle=alert(1)><summary>s</summary>text</details>",
  mdInHtml: "<div>\n\n**bold** [x](javascript:alert(1))\n\n</div>",
  mdInHtmlInline: "<b>**x**</b> <i>[y](javascript:alert(1))</i>",
  tableHtml: "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |\n| [x](javascript:alert(1)) | `<b>` |",
  tableAlign: "| a | b |\n|:--|--:|\n| 1 | 2 |",
  footnote: "text[^1]\n\n[^1]: <script>alert(1)</script> [x](javascript:alert(1))",
  taskList: "- [x] <script>alert(1)</script>\n- [ ] [x](javascript:alert(1))",
  headingHtml: "# <img src=x onerror=alert(1)>",
  emphasisHtml: "*<script>alert(1)</script>* __<img src=x onerror=1>__",
  codeBlock: "```<script>alert(1)</script>\n<script>alert(1)</script>\n```",
  codeLang: "```\"><script>alert(1)</script>\nx\n```",
  codeSpan: "`<script>alert(1)</script>`",
  indentedCode: "    <script>alert(1)</script>",
  blockquote: "> <script>alert(1)</script>\n> [x](javascript:alert(1))",
  titleAttr: "[x](https://ok.example \"\" onmouseover=\"alert(1)\")",
  titleQuote: "[x](https://ok.example \"a\\\" onmouseover=\\\"alert(1)\")",
  hrefQuote: "[x](https://ok.example/\"onmouseover=\"alert(1))",
  hrefAngleQuote: "[x](<https://ok.example/\" onmouseover=\"alert(1)>)",
  mailtoLink: "[x](mailto:a@b.example?subject=hi)",
  unicodeColon: "[x](javascript：alert(1))",
  bidi: "[x](‮javascript:alert(1))",
  deepQuote: "> ".repeat(2000) + "x",
  deepList: Array.from({ length: 300 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n"),
  deepBrackets: "[".repeat(5000) + "x](javascript:alert(1))",
  deepEmphasis: "*a ".repeat(5000),
  deepHtml: "<div>".repeat(5000) + "<script>alert(1)</script>",
  deepHtmlInline: "x<b>".repeat(5000) + "<img src=x onerror=1>",
};

describe("hostile markdown corpus", () => {
  test("has at least 40 payloads", () => {
    expect(Object.keys(PAYLOADS).length).toBeGreaterThanOrEqual(40);
  });
  for (const [name, src] of Object.entries(PAYLOADS)) {
    // Layer 1 alone must already be safe: it is the renderer, with no sanitizer after it.
    test(`${name}: the renderer alone is safe`, () => {
      expect(problems(markdownToHtml(src), false)).toEqual([]);
    });
    // Both layers: the result is safe, or the render failed and gave undefined (the preview then shows plain text).
    test(`${name}: renderMarkdown is safe`, () => {
      const out = renderMarkdown(src);
      if (out !== undefined) expect(problems(out, true)).toEqual([]);
    });
  }
});

describe("what renders", () => {
  test("a safe link keeps its text and address", () => {
    const a = new DOMParser().parseFromString(renderMarkdown("[hi](https://example.com/a?b=1&c=2)")!, "text/html").querySelector("a")!;
    expect([a.textContent, a.getAttribute("href")]).toEqual(["hi", "https://example.com/a?b=1&c=2"]);
  });
  test("a bad link becomes its plain text", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("[click me](javascript:alert(1))")!, "text/html");
    expect(doc.querySelector("a")).toBeNull();
    expect(doc.body.textContent).toContain("click me");
  });
  test("raw html shows as text", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("<script>alert(1)</script>\n\nhi")!, "text/html");
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.body.textContent).toContain("<script>alert(1)</script>");
  });
  test("an image shows as a text link and never as an img", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("![logo](https://example.com/l.png)")!, "text/html");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("a")?.textContent).toBe("Image: logo");
  });
  test("task list items show as text marks", () => {
    const text = new DOMParser().parseFromString(renderMarkdown("- [x] done\n- [ ] todo")!, "text/html").body.textContent;
    expect(text).toContain("[x] done");
    expect(text).toContain("[ ] todo");
  });
  test("tables, headings and code blocks render", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```")!, "text/html");
    expect(doc.querySelector("h1")?.textContent).toBe("T");
    expect(doc.querySelectorAll("td").length).toBe(2);
    expect(doc.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(doc.querySelector("pre code")?.hasAttribute("class")).toBe(false);
  });
});

describe("safeHref", () => {
  test("keeps http, https and mailto only", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref("HTTP://a.example")).toBe("HTTP://a.example");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    for (const bad of ["javascript:x", " https://a.example", "//a.example", "/a", "a.html", "data:x", "vbscript:x", "https://a.example/\"x", "https://a.example/<x", "https://a.example/\u0001", "", undefined, null]) {
      expect(safeHref(bad)).toBeUndefined();
    }
  });
});

describe("limits", () => {
  test("a 256 KB input renders in a few seconds, or gives undefined", () => {
    const unit = "# t\n\n| a | b |\n|---|---|\n| 1 | [x](https://ok.example) |\n\n- [ ] item **bold** `c`\n\n";
    const big = unit.repeat(Math.ceil(262144 / unit.length)).slice(0, 262144);
    const start = performance.now();
    const out = renderMarkdown(big);
    // jsdom is about ten times slower than a browser. The real browser check (Task 6) measures the true time.
    expect(performance.now() - start).toBeLessThan(5000);
    expect(out).toBeDefined();
  });
  test("renderMarkdown never throws", () => {
    expect(() => renderMarkdown("\u0000".repeat(1000))).not.toThrow();
  });
});
````

- [ ] **Step 3: See both tests fail.** Run `cd web && bun --bun vitest run src/lib/features/sessions/sanitize.test.ts src/lib/features/sessions/markdown.test.ts`. They fail because `./sanitize` and `./markdown` do not exist.
- [ ] **Step 4: Write `sanitize.ts`.** Use this code exactly.

````ts
// The second layer of the safety rules for formatted text. Both functions take HTML text and give back SafeHtml.
// This is the only file that makes the SafeHtml type, and FormattedText.svelte is the only file that shows it.
// Only the browser runs this file (it needs `window`). The preview loads it by dynamic import.
import createDOMPurify from "dompurify";

declare const safe: unique symbol;
/** HTML that went through one of the two sanitizers in this file. The type has no other source. */
export type SafeHtml = string & { readonly [safe]: true };

/** The only tags that markdown output may keep. No img, svg, math, iframe, form, input, style, meta, base or details. */
export const MARKDOWN_TAGS = ["a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "table", "thead", "tbody", "tr", "th", "td"] as const;
// A link address must start with one of these. DOMPurify tests the address after it removes control characters and white space.
const URI = /^(?:https?:|mailto:)/i;

// Each sanitizer has its own DOMPurify instance, so that the link hook of one never runs for the other.
const markdownPurify = createDOMPurify(window);
markdownPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

/** Markdown output: fixed tags, only `href` and `title` on links, only http, https and mailto addresses. No `class`, no `style`, no handlers. */
export const sanitizeMarkdownHtml = (html: string): SafeHtml =>
  markdownPurify.sanitize(html, {
    ALLOWED_TAGS: [...MARKDOWN_TAGS],
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_URI_REGEXP: URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as SafeHtml;

const codePurify = createDOMPurify(window);

/** Code color output of highlight.js: only `span` with `class`. Every other tag is dropped and its text kept. */
export const sanitizeCodeHtml = (html: string): SafeHtml =>
  codePurify.sanitize(html, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as SafeHtml;
````

- [ ] **Step 5: Write `markdown.ts`.** Use this code exactly. `this: any` in the `link` renderer is on purpose: `marked` binds `this.parser` there and its type is not exported in a simple form. Do not use `any` anywhere else.

````ts
// Markdown to safe HTML, in two layers. Layer 1 is the renderer below: it turns raw HTML into text, renders an image as a
// text link, keeps only http, https and mailto links, and never writes a class. Layer 2 is sanitizeMarkdownHtml. The tests
// check layer 1 alone and both layers together, so that a mistake in one layer does not hide behind the other.
import { Marked, type Tokens } from "marked";
import { sanitizeMarkdownHtml, type SafeHtml } from "./sanitize";

/** Escapes text for use in HTML text and in a double-quoted or single-quoted attribute. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The address if it is safe to link, else undefined. The address must START with http://, https:// or mailto: with no
 * white space or control character before it. This checks the raw text, so an entity such as java&#115;cript: or a percent
 * form never reaches a scheme check: it does not start with the allowed text, so it is refused.
 */
export function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  return /^(?:https?:\/\/|mailto:)[^\s<>"'`\\\u0000-\u001f\u007f]*$/i.test(href) ? href : undefined;
}

// One shared renderer. The overrides replace the marked renderers for html, code, link, image and task list marks.
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return "block" in token && token.block ? `<p>${esc(token.text.trim())}</p>\n` : esc(token.text);
    },
    code({ text }: Tokens.Code) {
      return `<pre><code>${esc(text)}</code></pre>\n`;
    },
    link(this: any, { href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const ok = safeHref(href);
      return ok ? `<a href="${esc(ok)}"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>` : inner;
    },
    image({ href, text }: Tokens.Image) {
      const label = esc(`Image: ${text || href}`);
      const ok = safeHref(href);
      return ok ? `<a href="${esc(ok)}">${label}</a>` : label;
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return checked ? "[x] " : "[ ] ";
    },
  },
});

/** Layer 1 only. Exported for the tests. Do not show this output: use renderMarkdown. */
export const markdownToHtml = (text: string): string => marked.parse(text, { async: false });
/** Layer 1 and layer 2. Gives undefined when anything throws (a stack overflow on deep nesting), so the preview shows plain text. */
export function renderMarkdown(text: string): SafeHtml | undefined {
  try {
    return sanitizeMarkdownHtml(markdownToHtml(text));
  } catch {
    return undefined;
  }
}
````

- [ ] **Step 6: See them pass.** Run the same command as in Step 3. All tests pass (each payload runs twice, plus the other tests). If a payload fails, read the `problems` list in the failure message. Fix `markdown.ts` or `sanitize.ts`. Do not edit the test.
- [ ] **Step 7: Run the checks.** `bun run --cwd web check` has 0 errors. `cd web && bun --bun vitest run src` is green.
- [ ] **Step 8: Commit.**

```bash
git add web/src/lib/features/sessions/sanitize.ts web/src/lib/features/sessions/sanitize.test.ts web/src/lib/features/sessions/markdown.ts web/src/lib/features/sessions/markdown.test.ts
git commit -m "feat(web): render markdown with a strict renderer and a DOMPurify second layer"
```

## Task 4: The highlighter and the loader

**Files:**
- Create: `highlight.ts`, `highlight.test.ts`, `highlightfail.test.ts`, `formatted.ts`, `formatted.test.ts` (all in `web/src/lib/features/sessions`)

**Interfaces:** `grammarLoaders`, `highlightCode`, `Formatted`, `Loaders`, `FAILED_NOTE`, `formatText`.

- [ ] **Step 1: Write the highlighter tests first.** Create `highlight.test.ts` and `highlightfail.test.ts`. The second one is its own file on purpose: highlight.js keeps a registered grammar for the whole file, and the failure test needs a grammar that is not registered yet.

````ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { grammarLoaders, highlightCode } from "./highlight";
import { LANGUAGES } from "./viewkind";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("highlightCode", () => {
  test("has one loader for each language of viewkind", () => {
    expect(Object.keys(grammarLoaders).sort()).toEqual([...LANGUAGES].sort());
  });
  test("every grammar loads and colors something", async () => {
    const samples: Record<string, string> = {
      typescript: "const a: number = 1;", javascript: "function f() { return 1; }", json: "{\"a\": 1}", python: "def f():\n    return 1", bash: "echo \"$HOME\" # c",
      yaml: "a: 1\nb: [x]", xml: "<a b=\"c\">d</a>", css: "a { color: red; }", sql: "SELECT 1 FROM t;", go: "func main() {}", rust: "fn main() {}",
      ini: "[s]\na = 1", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y", dockerfile: "FROM node\nRUN echo 1", makefile: "all:\n\techo 1",
    };
    for (const lang of LANGUAGES) {
      const out = await highlightCode(samples[lang]!, lang);
      expect(out, lang).toBeDefined();
      expect(doc(out!).querySelectorAll("span[class^='hljs-']").length, lang).toBeGreaterThan(0);
    }
  });
  test("a hostile source file comes out as escaped text", async () => {
    const src = [
      "const a = \"<script>alert(1)</script>\"; // <img src=x onerror=alert(1)>",
      "<svg onload=alert(1)></svg>",
      "<a href=\"javascript:alert(1)\" onclick=\"x\">y</a>",
      "</span><script>alert(2)</script><span class=\"hljs-keyword\" onclick=\"alert(3)\">",
      "<iframe src=javascript:alert(4)></iframe><style>*{x:y}</style>",
    ].join("\n");
    for (const lang of ["typescript", "xml", "bash"] as const) {
      const out = (await highlightCode(src, lang))!;
      const d = doc(out);
      expect(Array.from(d.body.querySelectorAll("*")).every((e) => e.tagName === "SPAN"), lang).toBe(true);
      for (const el of Array.from(d.body.querySelectorAll("*"))) expect(Array.from(el.attributes).map((a) => a.name), lang).toEqual(["class"]);
      for (const el of Array.from(d.body.querySelectorAll("span"))) expect(el.className, lang).toMatch(/^(hljs-[a-z_ -]*|language-[a-z]+)$/i);
      // The text is the same as the input: nothing was lost or turned into a tag.
      expect(d.body.textContent, lang).toBe(src);
    }
  });
  test("a 128 KB input colors in a few seconds", async () => {
    const big = "const a: number = 1; // comment \"str\"\n".repeat(Math.ceil(131072 / 38)).slice(0, 131072);
    const start = performance.now();
    expect(await highlightCode(big, "typescript")).toBeDefined();
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
````

````ts
// @vitest-environment jsdom
import { expect, test } from "vitest";
import { grammarLoaders, highlightCode } from "./highlight";

// This test has its own file because a registered grammar stays registered for the whole file. Here no test loads Go first.
test("highlightCode gives undefined and does not throw when the grammar fails to load (offline)", async () => {
  grammarLoaders.go = () => Promise.reject(new Error("offline"));
  expect(await highlightCode("func main() {}", "go")).toBeUndefined();
});
````

- [ ] **Step 2: Write the loader test first.** Create `formatted.test.ts`. It has no DOM line, because it uses fake loaders and never loads a library.

````ts
import { describe, expect, test } from "vitest";
import { FAILED_NOTE, formatText, type Loaders } from "./formatted";
import type { SafeHtml } from "./sanitize";
import { CODE_LIMIT, MARKDOWN_LIMIT } from "./viewkind";

const html = "<p>x</p>" as SafeHtml;
const ok: Loaders = {
  markdown: async () => ({ renderMarkdown: () => html, markdownToHtml: () => "", safeHref: () => undefined }),
  highlight: async () => ({ highlightCode: async () => html, grammarLoaders: {} as never }),
};
const boom: Loaders = { markdown: () => Promise.reject(new Error("offline")), highlight: () => Promise.reject(new Error("offline")) };
const never: Loaders = { markdown: () => { throw new Error("must not load"); }, highlight: () => { throw new Error("must not load"); } };

describe("formatText", () => {
  test("markdown and code use their loaders", async () => {
    expect(await formatText("a.md", "# x", ok)).toEqual({ kind: "markdown", html });
    expect(await formatText("a.ts", "let a", ok)).toEqual({ kind: "code", html });
  });
  test("a plain file never loads a library", async () => {
    expect(await formatText("a.txt", "x", never)).toEqual({ kind: "plain" });
  });
  test("a too large file never loads a library and carries the note", async () => {
    const md = await formatText("a.md", "x".repeat(MARKDOWN_LIMIT + 1), never);
    const code = await formatText("a.ts", "x".repeat(CODE_LIMIT + 1), never);
    expect(md.kind).toBe("plain");
    expect(code.kind).toBe("plain");
    expect(md.kind === "plain" && md.note).toContain("256 K characters");
    expect(code.kind === "plain" && code.note).toContain("128 K characters");
  });
  test("a file exactly at the limit is formatted", async () => {
    expect((await formatText("a.md", "x".repeat(MARKDOWN_LIMIT), ok)).kind).toBe("markdown");
    expect((await formatText("a.ts", "x".repeat(CODE_LIMIT), ok)).kind).toBe("code");
  });
  test("a library that fails to load (offline) gives plain text with a note and does not throw", async () => {
    expect(await formatText("a.md", "# x", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "let a", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
  test("a render that gives undefined falls back to plain text", async () => {
    const none: Loaders = { markdown: async () => ({ renderMarkdown: () => undefined, markdownToHtml: () => "", safeHref: () => undefined }), highlight: async () => ({ highlightCode: async () => undefined, grammarLoaders: {} as never }) };
    expect(await formatText("a.md", "x", none)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "x", none)).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
});
````

- [ ] **Step 3: See the tests fail.** Run `cd web && bun --bun vitest run src/lib/features/sessions/highlight.test.ts src/lib/features/sessions/highlightfail.test.ts src/lib/features/sessions/formatted.test.ts`. They fail because the modules do not exist.
- [ ] **Step 4: Write `highlight.ts`.** Use this code exactly. Each `import()` is a separate chunk in the build. `ignoreIllegals: true` makes highlight.js color what it can instead of throwing on odd input.

````ts
// Code colors. highlight.js core is imported here, and each grammar loads on demand, the first time a file of that
// language opens. The result goes through sanitizeCodeHtml, which keeps only span and class.
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import { sanitizeCodeHtml, type SafeHtml } from "./sanitize";
import type { LanguageId } from "./viewkind";

type Loader = () => Promise<{ default: LanguageFn }>;
/** One loader for each language of viewkind.ts. Each import is a separate chunk. Tests replace a loader to simulate a failed load. */
export const grammarLoaders: Record<LanguageId, Loader> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  bash: () => import("highlight.js/lib/languages/bash"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  sql: () => import("highlight.js/lib/languages/sql"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  ini: () => import("highlight.js/lib/languages/ini"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
};

/** Colored HTML for `text`, or undefined when the grammar fails to load or highlight.js throws. */
export async function highlightCode(text: string, language: LanguageId): Promise<SafeHtml | undefined> {
  try {
    if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await grammarLoaders[language]()).default);
    return sanitizeCodeHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value);
  } catch {
    return undefined;
  }
}
````

- [ ] **Step 5: Write `formatted.ts`.** Use this code exactly. `import type { SafeHtml }` must stay a type import, so that `sanitize.ts` (and DOMPurify) is not pulled into the page code. The `import()` lines are the only places that name `./markdown` and `./highlight`.

````ts
// Chooses how to show the text of a file and loads the libraries it needs. This is the only file that imports markdown.ts
// and highlight.ts, and it does so by dynamic import, so the libraries stay out of every other page. It never throws.
import type { SafeHtml } from "./sanitize";
import { viewKind } from "./viewkind";

export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "code"; html: SafeHtml } | { kind: "plain"; note?: string };
/** The two dynamic imports. Tests pass loaders that fail, to simulate a chunk that does not load (offline). */
export type Loaders = { markdown: () => Promise<typeof import("./markdown")>; highlight: () => Promise<typeof import("./highlight")> };
const defaultLoaders: Loaders = { markdown: () => import("./markdown"), highlight: () => import("./highlight") };
export const FAILED_NOTE = "This file could not be formatted. It shows as plain text.";

/** `name` is the file name, `text` is the preview text. The result is never an error: a failure gives plain text with a note. */
export async function formatText(name: string, text: string, loaders: Loaders = defaultLoaders): Promise<Formatted> {
  const plan = viewKind(name, text.length);
  if (plan.kind === "plain") return plan.note ? { kind: "plain", note: plan.note } : { kind: "plain" };
  try {
    const html = plan.kind === "markdown" ? (await loaders.markdown()).renderMarkdown(text) : await (await loaders.highlight()).highlightCode(text, plan.language);
    if (html !== undefined) return { kind: plan.kind, html };
  } catch {
    // The chunk did not load (offline) or a library threw: fall through to plain text.
  }
  return { kind: "plain", note: FAILED_NOTE };
}
````

- [ ] **Step 6: See the tests pass.** Run the command of Step 3. All pass. The test "every grammar loads and colors something" proves that all 15 grammars exist at the paths in `grammarLoaders`.
- [ ] **Step 7: Run the checks.** `bun run --cwd web check` has 0 errors. `cd web && bun --bun vitest run src` is green.
- [ ] **Step 8: Commit.**

```bash
git add web/src/lib/features/sessions/highlight.ts web/src/lib/features/sessions/highlight.test.ts web/src/lib/features/sessions/highlightfail.test.ts web/src/lib/features/sessions/formatted.ts web/src/lib/features/sessions/formatted.test.ts
git commit -m "feat(web): color code with lazy highlight.js grammars and fall back to plain text"
```

## Task 5: The component, the styles and the FilePreview switches

**Files:**
- Create: `FormattedText.svelte`, `FormattedText.test.ts`, `formatted.css` (in `web/src/lib/features/sessions`), `web/src/lib/rawhtml.test.ts`
- Modify: `web/src/lib/features/sessions/FilePreview.svelte`

**Interfaces:** `FormattedText` props (see Interfaces). Marks: `data-preview`, `.formatted-md`, `.formatted-code`, the `Rendered`, `Source` and `Wrap` buttons.

`FilePreview.svelte` has no unit test. It needs a query client and a network stub, and the real browser check of Task 6 covers it with more value. The parts with logic are already tested: `formatText`, `viewKind` and the component.

- [ ] **Step 1: Write the raw HTML test first.** Create `web/src/lib/rawhtml.test.ts`. It uses `fileURLToPath` and not `import.meta.dir`, because `import.meta.dir` was undefined for this file in the test run.

@@/tmp/fp/src/lib/rawhtml.test.ts:ts@@

- [ ] **Step 2: Write the component test first.** Create `FormattedText.test.ts`. It passes the output of the real renderers through the component and reads the live page.

@@FormattedText.test.ts:ts@@

- [ ] **Step 3: See both tests fail.** Run `cd web && bun --bun vitest run src/lib/rawhtml.test.ts src/lib/features/sessions/FormattedText.test.ts`. `rawhtml.test.ts` fails because no file has the insert yet (it expects one hit). `FormattedText.test.ts` fails because the component does not exist.
- [ ] **Step 4: Write `FormattedText.svelte`.** Use this code exactly. It has one `svelte:element` so the raw HTML insert appears once. The comment in it must not contain the raw insert text. The `nowrap` class makes the code box scroll sideways inside its own box.

@@FormattedText.svelte:svelte@@

- [ ] **Step 5: Write `formatted.css`.** Use this CSS exactly. It uses only theme variables from `app.css` and `layout.css` (`--primary`, `--ok`, `--warn`, `--muted-foreground`, `--destructive`, `--foreground`, `--card`, `--muted`, `--border`), so light, dark, Ayu and Tokyo Night all work. `--tok-number` mixes `--warn` with the text color because the light `--warn` has a contrast of only 4.2 on the card color. The table rules matter: `display: block` with `overflow-x: auto` puts a wide table in its own scroll box, and `overflow-wrap: normal` on cells keeps words whole, so the table is wide instead of squeezed to nothing. No highlight.js theme file is loaded.

@@formatted.css:css@@

- [ ] **Step 6: Replace `FilePreview.svelte`.** Use this file exactly. What changed from the old file: the imports of `formatText` and `FormattedText`, two `$state` values (`rendered`, `wrap`), a `plain` snippet (the old `pre`, with a `data-preview` mark), and the `{#await formatText(...)}` block. While the formatting loads, the plain text shows, so the screen is never empty. `formatText` never rejects, so there is no `{:catch}`. The Back button, the file header, the truncation note, the binary text and the Download button are unchanged. The two switch rows use the same `Button` with `size="touch"` (44 px high) as the Touched and Folder tabs in `SessionView.svelte`.

@@FilePreview.svelte:svelte@@

- [ ] **Step 7: See the tests pass.** Run `cd web && bun --bun vitest run src/lib/rawhtml.test.ts src/lib/features/sessions/FormattedText.test.ts`. All pass.
- [ ] **Step 8: Run all checks.**

```bash
export PATH=$HOME/.bun/bin:$PATH
bun run typecheck
bun run --cwd web check
(cd web && bun --bun vitest run src 2>&1 | tail -8)
bun run --cwd web build 2>&1 | tail -30
```

  All pass. `web/src/lib/boundaries.test.ts` is part of the test run, and it must stay green. In the build output, look for chunks: a chunk of about 30 KB (DOMPurify), one of about 50 KB (marked), one of about 40 KB (highlight.js core) and about 15 small chunks (one for each grammar) must exist as separate files. If the build puts these in one big entry chunk, a static import is wrong. Find it and fix it before you go on.
- [ ] **Step 9: Commit.**

```bash
git add web/src/lib/features/sessions/FormattedText.svelte web/src/lib/features/sessions/FormattedText.test.ts web/src/lib/features/sessions/formatted.css web/src/lib/features/sessions/FilePreview.svelte web/src/lib/rawhtml.test.ts
git commit -m "feat(web): show rendered markdown and colored code in the file preview"
```

## Task 6: A real browser check

This task changes no file in the repo. It builds the web app, starts the real hub app with a fake sign-in and a fake instance, and drives it with Playwright at a phone size, in light and in dark. The hub app is `createApp` from `server/src/app.ts`, with a fake `UserAuthStrategy` (it sets a user and calls `next`) and `staticHandler` from `server/src/static.ts`, which serves `web/dist`. The sessions routes read a real transcript file in a temporary home folder, so the real session code serves the demo files. The same approach as `server/test/sessionapi.test.ts` and the earlier end to end run.

Playwright is installed. `require("playwright")` works in a Bun script, and `chromium.launch()` needs no options. The script is a throwaway. It lives in `/tmp/fpcheck`, outside the repo.

- [ ] **Step 1: Build.** Run `export PATH=$HOME/.bun/bin:$PATH && bun run --cwd web build 2>&1 | tail -3`. It ends with `done`. The build is in `web/dist`.
- [ ] **Step 2: Write the script.** Run `mkdir -p /tmp/fpcheck`. Save this text as `/tmp/fpcheck/check.ts`. It makes these demo files in a temporary folder: `report.md` (headings, lists, a task list, a quote, a wide table of 8 columns, a code block, a `<script>alert(1)</script>` line, a `javascript:` link, an entity encoded `javascript:` link, a remote image and an `<img onerror>` tag), `app.ts` (TypeScript with a 300 character comment line), `big.md` (300 KB, too large), `mid.md` (about 250 KB, just under the limit), `blob.bin` (binary) and `notes.txt` (plain).

@@/tmp/fpcheck/check.ts:ts@@

- [ ] **Step 3: Run it.** From the repo root:

```bash
export PATH=$HOME/.bun/bin:$PATH
REPO=$PWD timeout 300 bun /tmp/fpcheck/check.ts 2>&1 | tee /tmp/fpcheck/out.txt | grep -v "^ok"
```

  The last line must be `all checks passed`. Every line starts with `ok`, `info` or `FAIL`. The check list covers, for light and for dark at 390 by 844: headings and lists render, no script, img, iframe, svg, form, style or handler in the rendered markdown, no `javascript:`, `data:` or `vbscript:` link, exactly two links remain (the safe link and the image link), every link has `target="_blank"` and `rel="noopener noreferrer nofollow"`, the script tag shows as text, the wide table scrolls inside its own box, no horizontal page scroll in each view, the Source switch shows the raw markdown, the code has at least 3 different colors, the Wrap switch makes the code scroll inside its own box, `big.md` shows the too-large note and is not rendered, `notes.txt` shows no note, `mid.md` renders in under 10 seconds with the CPU slowed 4 times, no dialog, no console error and no failed request (except the 501 answers of the three feed addresses that the fake hub does not have). It also checks the contrast of the code colors in four palettes, and that the sessions list page does not load the library code. If a check fails, fix the code in the repo, rebuild and run again. Do not change a check to make it pass, unless the check itself is wrong, and then say so in your report.
- [ ] **Step 4: Look at the screenshots.** The script writes them to `/tmp/fpcheck/shots`. Open each with the Read tool: `light-report-rendered.png`, `dark-report-rendered.png`, `light-report-source.png`, `light-code-wrapped.png`, `dark-code-wrapped.png`, `dark-code-nowrap.png`, `light-too-large.png`, `dark-binary.png` and the four `palette-*-code.png`. Look for: text that is hard to read, a table that cuts off without a scroll box, a button that is too small to tap, a color that is hard to see on its background, and a layout that breaks. The bottom navigation bar shows in the middle of the full page screenshots. That is normal, because the bar is fixed. Write down what you saw in your report. Report the `info` line with the `mid.md` time.
- [ ] **Step 5: Check that nothing leaked into the repo.** Run `git status --short`. Only the files that were untracked at the start (`.oidc/`, `.serena/`, `HANDOVER.md`, `run.sh`) may appear. There is no commit in this task.

## Task 7: Documentation

**Files:**
- Modify: `README.md`, `docs/session-files.md`

- [ ] **Step 1: README.** In the "Session files" section, replace the bullet that starts with `- A text file shows as plain text.` (it has two lines) with this text:

```markdown
- A markdown file (`.md` or `.markdown`) shows rendered, with headings, lists, tables, code blocks, quotes, links and
  task lists. A switch at the top shows the plain text instead. A file in one of these languages shows with colors:
  TypeScript, JavaScript, JSON, Python, shell, YAML, HTML and XML (also Svelte and Vue), CSS, SQL, Go, Rust, INI and
  TOML, diff, Dockerfile and Makefile. A switch turns line wrapping on and off. Any other text file shows as plain
  text. A larger text file shows its first 512 KB and a download button. Any other file is a download.
- The preview formats only a small file. It renders markdown up to 256 K characters and it colors code up to 128 K
  characters. K is 1,024, and the count is characters of the text, not bytes. A larger file shows as plain text with
  a note. If formatting fails for any reason, the file shows as plain text with a note.
- A markdown file cannot run code or load anything from another site. The preview shows raw HTML in the file as text.
  It never loads an image: an image shows as a link with its alt text. It keeps only links that start with
  `http://`, `https://` or `mailto:`. Any other link, including a relative link, shows as plain text. A link that stays
  opens in a new tab.
```

  Then replace the paragraph that starts with `The first version shows only the work trees` with: `The preview has no editor, no line numbers and no search. Session files are not yet verified on Windows nodes.` Keep the rest of the section.
- [ ] **Step 2: The code guide.** In `docs/session-files.md`, add these rows to the module map table, after the `format.ts (web)` row:

```markdown
| `viewkind.ts` (web) | Pure. Decides how a preview shows a text file: plain, markdown or code, and the language. It holds the file name map and the two size limits. |
| `formatted.ts` (web) | Loads the formatting code by dynamic import and gives the formatted preview. It falls back to plain text when anything fails. |
| `markdown.ts`, `highlight.ts`, `sanitize.ts` (web) | The markdown renderer, the code colors and the two sanitizers. Only the preview page loads them. |
| `FormattedText.svelte` (web) | The only place that inserts HTML into the page. It takes only text that went through a sanitizer. |
```

  Then add a new section at the end of the file, after "Cost and threading", with this text:

```markdown
## How the web preview formats a file

The server sends the same preview JSON as before. The browser does the formatting. `FilePreview.svelte` calls
`formatText` with the file name and the text. `viewKind` picks the view from the name and the number of characters of
the text. It never looks at bytes. A markdown file up to 256 K characters renders as markdown. A code file up to 128 K
characters gets colors. K is 1,024. A larger file, and any other file, shows as plain text.

The formatting libraries are `marked`, `dompurify` and `highlight.js`. They load by dynamic import, only when a preview
opens. A highlight.js grammar loads when a file of that language opens. If an import fails, for example when the phone
is offline, the file shows as plain text with a note.

Markdown has two safety layers, and a hostile file must get past both. Layer 1 is the `marked` renderer in
`markdown.ts`. It shows raw HTML as text. It shows an image as a text link. It keeps a link only if its address starts
with `http://`, `https://` or `mailto:`, tested on the raw text before any decoding. It never writes a `class`.
Layer 2 is DOMPurify in `sanitize.ts`. It keeps a fixed list of tags, only `href` and `title` on links, and only the
same three address types. It adds `target="_blank"` and `rel="noopener noreferrer nofollow"` to every link. The code
colors from highlight.js also go through DOMPurify, which keeps only `span` with `class`.

`sanitize.ts` is the only file that makes the `SafeHtml` type. `FormattedText.svelte` takes only that type, and it is
the only file in the app that inserts HTML. `rawhtml.test.ts` fails if any other file does. `markdown.test.ts` runs a
corpus of hostile payloads against layer 1 alone and against both layers. Tests that use DOMPurify run in `jsdom`.
They must not run in `happy-dom`, because DOMPurify keeps a script tag there.

The colors are the rules in `formatted.css`. They use the theme variables, so every palette works. The contrast of the
code colors was checked in all four palettes.
```
- [ ] **Step 3: Check the text.** Read both changes. Short sentences, no contractions, no semicolons, no em-dashes. Run `git diff --stat`. Only `README.md` and `docs/session-files.md` changed.
- [ ] **Step 4: Run the full checks.** These all pass:

```bash
export PATH=$HOME/.bun/bin:$PATH
bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)
bun test server ./cli 2>&1 | tail -5
bun run typecheck
bun run --cwd web check
(cd web && bun --bun vitest run src 2>&1 | tail -8)
bun run build:web 2>&1 | tail -3
```

- [ ] **Step 5: Commit.**

```bash
git add README.md docs/session-files.md
git commit -m "docs: describe the formatted file preview"
```

## Not in this feature

Images from the session folder, JSON and CSV views, a search box in the preview, relative links between markdown files, table alignment, colors inside markdown code blocks, and line numbers.
