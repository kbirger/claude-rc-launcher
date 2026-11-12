# Formatted Preview With CodeMirror: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The file preview shows code with colors in a read-only CodeMirror 6 view. It replaces `highlight.js`, which froze the page on some inputs. The view builds only the lines in view, so every size up to the server cut of 512 KB opens at once. Rendered markdown keeps the strict renderer, DOMPurify and the worker with a two second limit. Code never goes through raw HTML.

**Architecture:** This plan replaces Task 4 and changes Tasks 5 to 7 of `docs/superpowers/plans/2026-11-12-formatted-preview.md`. Tasks 1 to 3 and the markdown worker stay as they are. New files in `web/src/lib/features/sessions`: `languages.ts` (the lazy language loader), `codetheme.ts` (the theme and the colors, from the app CSS variables), `editor.ts` (the only file that imports CodeMirror core), `CodeView.svelte` (the viewer, which loads `editor.ts` and the language by `import()`), `FormattedText.svelte` (markdown only), `formatted.css` (markdown only). `viewkind.ts` stays pure and gets a new rule for plain text. `formatted.ts` renders markdown only.

**Tech Stack:** Svelte 5, SvelteKit with adapter-static, Tailwind, Vitest with `jsdom`, Playwright. New dependencies: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/highlight`, `@codemirror/lang-javascript`, `lang-json`, `lang-python`, `lang-yaml`, `lang-html`, `lang-css`, `lang-sql`, `lang-go`, `lang-rust`, `lang-markdown` and `@codemirror/legacy-modes`. Removed: `highlight.js`.

**Spec:** `docs/superpowers/specs/2026-11-12-formatted-preview-design.md`, section "Change of plan (2026-11-12)". It is binding. The ledger rulings 1 to 6 are binding too.

**Proof:** Every file in this plan was written and run in a scratch copy of the branch (`/tmp/fpcm`, made from commit `56b4bac`). There, 1112 web tests, `svelte-check`, `tsc`, `bun test server ./cli` (1840 tests), `bun run --cwd web build` and the Playwright check (109 `ok` lines, `all checks passed`) all passed, and both frozen installs passed.

## Global Constraints

1. Constraints 1 to 14 of the original plan still hold, except where this plan says otherwise. The changes: the code color limit and `highlight.js` are gone. The test count falls once, in Task A, because the `highlight.js` tests are deleted (the scratch copy went from 1137 tests to 1077 after Task A and ended at 1112). Write the numbers in the commit messages. After Task A the count must only grow.
2. Code is shown only by `CodeView.svelte`. CodeMirror writes text nodes. No code text ever goes through an HTML string. `{@html` stays in `FormattedText.svelte`, exactly once. `rawhtml.test.ts` guards this.
3. CodeMirror loads only when a preview shows code or a source view. `CodeView.svelte` and `languages.ts` import CodeMirror only as types (`import type`) and by `import()`. Only `editor.ts` and `codetheme.ts` import CodeMirror core, and only `CodeView.svelte` imports `editor.ts`, by `import()`. Every language is its own `import()`.
4. The code colors use only theme variables (`var(--primary)` and the like), so a theme switch needs no rebuild of the editor.
5. The size rules: markdown renders up to 100 K characters (K is 1,024). Code has no limit below the server cut of 512 KB. Plain text shows in a `<pre>` up to 64 K characters and in `CodeView` with no language above that.
6. The files of the markdown worker (`formatjobs.ts`, `format.worker.ts`, `formatrunner.ts`, `guards.ts`, `formatted.ts`, `markdown.ts`) are part of the markdown pipeline. Task A removes only the code (highlight) parts from them. It must not change any markdown behavior.
7. Run every command with `export PATH=$HOME/.bun/bin:$PATH` first. Each step names the folder. Web tests run as `cd web && bun --bun vitest run <path>`. The full checks are `bun test server ./cli`, `bun run typecheck`, `bun run --cwd web check` and `cd web && bun --bun vitest run src`, from the repo root unless a `cd` is shown. A `bun add` or `bun remove` may print `SyntaxError ... styleText` from the `prepare` script, because the system `node` is old. The install still works. Ignore that line.
8. One task, one commit. Test first where a test makes sense. Plain English in documents and comments: short sentences, no contractions, no semicolons, no em-dashes, the condition before the command. Do not commit screenshots. Do not change a file that a task does not name.

## Review Focus

Each item names a way that this feature can still hurt, and the test or check that pins it.

- **The markdown worker and the sanitizer.** They are covered by the earlier tasks. What changes here: the worker accepts only a markdown job, `sanitizeCodeHtml` and its class rule are gone, and `formatText` returns only `markdown` or `plain`. Check that `markdown.test.ts` and `sanitize.test.ts` still run all their payloads and that no payload was removed. `formatrunner.test.ts` must show that a job of another kind is refused by the worker.
- **CodeMirror in jsdom against a real browser.** jsdom has no layout. The unit tests cover mounting, text, classes, language changes, `destroy` and the two failure paths. They cannot cover heights, wrapping on screen, scrolling, selection, painted colors, contrast or a theme switch. Task E covers those in Chromium. A reviewer must not accept a green jsdom run as proof of the layout.
- **Mobile selection and scrolling inside a scrolling page.** Decision: the code view has no scroll box of its own for the vertical direction. It grows with the page, as the old `<pre>` did. A swipe that starts in the code scrolls the page, so there is no scroll trap. With Wrap off, the code scrolls sideways inside its own box (`.cm-scroller`, `overflow-x: auto`). CodeMirror measures the part of the document that is in view against the window, so it builds about 10 to 40 lines even for a 512 KB file. Why not a box with `max-height: 70vh`: on a 844 px phone that box covers most of the screen, and a swipe that starts in it scrolls the box first and the page only after the end of the box. Task E (Part 3) swipes with real touch events inside the code and checks that the page moves, that a sideways swipe moves only the code box, that scrolling to the end of a 512 KB file builds the last line and reaches the Download button, and that a double click selects a word and a line can be selected. A full page screenshot of a long file can show a gap below the fold, because lines are built when they come into view. This is normal. Do not "fix" it.
- **The bundle.** The initial entry must stay free of CodeMirror, marked and DOMPurify. `initcheck.ts` (Task B and Task E) reads the Vite manifest and fails on the marker strings `cm-scroller`, `cm-content`, `ALLOWED_TAGS` and `walkTokens` in any file of the entry closure. The check uses strings from inside the libraries, not names from our code, because `languages.ts` names `StreamLanguage` as a plain identifier. Task E also loads the sessions list page in Chromium and checks that no script file it loads holds these markers.
- **Theme switching.** The colors are CSS variables read at paint time. Task E switches the `dark` class on a live editor and checks that a keyword changes color and that it is the same editor element. It also computes the contrast of the six colors against the code box in four palettes (at least 4.5).
- **Memory leaks when many previews open.** `CodeView.svelte` calls `destroy()` in its cleanup. `CodeView.test.ts` spies on `EditorView.prototype.destroy` and opens 20 views. It expects 20 calls. Removing the call makes this test fail (proven by mutation in the scratch copy). A view that unmounts before the editor loaded must build no editor at all.
- **A huge single line with wrapping on.** `min.ts` (512 KB on one line) and `aaa.ts` (131072 times `a`) open with Wrap on in Task E at 1x and 4x CPU slowdown, in under 1.5 seconds, with one DOM line, and the Wrap switch works for them too.
- **A failed lazy import offline.** If the editor chunk fails, `CodeView` shows the text in a `<pre>` (`CodeViewfail.test.ts`). If only the language chunk fails, the editor shows without colors (`CodeViewlang.test.ts`). Task E blocks the editor chunk in Chromium and checks the `<pre>` and the Download button. Known limit: the fallback `<pre>` for a 512 KB file is a big DOM. This is what the preview did before this feature, and it happens only offline.
- **Size rules.** `viewkind.test.ts` pins the 100 K markdown limit at its edge, that code has no limit, and the 64 K plain text edge. A `*a_` file must be 34133 repeats (102,399 characters). The 34134 repeats named in the ledger make 102,402 characters, which is over the limit, so that file would show the too-large note and never reach the worker.
- **`{@html` creeping elsewhere.** `rawhtml.test.ts` scans every app source file. Adding `{@html` to `CodeView.svelte` fails it (proven in the scratch copy).
- **Keyboard users.** The code view is not focusable and has no outline, as the spec asks. A keyboard user can still scroll the page. Wrap off puts a horizontal scroll box in the page that a keyboard cannot reach. This is accepted for the first version.

## File structure

All paths are under `web/src/lib/features/sessions` unless a full path is given.

| File | Status | One job |
| --- | --- | --- |
| `highlight.ts`, `highlight.test.ts`, `highlightfail.test.ts` | Delete | The highlight.js code. |
| `viewkind.ts`, `viewkind.test.ts` | Modify | Drop `CODE_LIMIT`. Add `PLAIN_PRE_LIMIT`, `showsInPre` and the `markdown` language id. |
| `sanitize.ts`, `sanitize.test.ts` | Modify | Drop `sanitizeCodeHtml` and the code class rule. |
| `formatjobs.ts`, `format.worker.ts`, `formatrunner.ts`, `formatrunner.test.ts`, `guards.ts`, `formatimports.test.ts` | Modify | Drop the code job and `hasLongWordRun`. |
| `formatted.ts`, `formatted.test.ts` | Modify | Markdown only. |
| `languages.ts`, `languages.test.ts` | Create | The lazy language loader and its test for every language. |
| `codetheme.ts` | Create | The CodeMirror theme and highlight style from the CSS variables. |
| `editor.ts` | Create | The read-only editor, built with CodeMirror core. |
| `CodeView.svelte`, `CodeView.test.ts`, `CodeViewfail.test.ts`, `CodeViewlang.test.ts` | Create | The viewer and its tests. |
| `reactiveprops.svelte.ts` | Create | A test helper: props that change. |
| `FormattedText.svelte`, `FormattedText.test.ts`, `formatted.css` | Create | Rendered markdown only. |
| `FilePreview.svelte` | Modify | The four views and the switches. |
| `web/src/lib/rawhtml.test.ts` | Create | One raw HTML insert in the app. |
| `web/package.json`, `web/bun.lock` | Modify | Dependencies. |
| `README.md`, `docs/session-files.md` | Modify | The guides. |
| `/tmp/fpcheck/check.ts`, `chunks.ts`, `initcheck.ts` | Throwaway, not in the repo | The browser check and the bundle reports. |

## Interfaces

```ts
// viewkind.ts (pure)
export const MARKDOWN_LIMIT = 102400;      // 100 * 1024 characters
export const PLAIN_PRE_LIMIT = 65536;      // 64 * 1024 characters
export const LANGUAGES: readonly [... 15 ids as before ..., "markdown"];   // 16 entries
export type LanguageId = (typeof LANGUAGES)[number];
export type ViewPlan = { kind: "markdown" } | { kind: "code"; language: LanguageId } | { kind: "plain"; note?: string };
export function languageFor(name: string): LanguageId | undefined;   // never returns "markdown"
export const isMarkdownName: (name: string) => boolean;
export function viewKind(name: string, length: number): ViewPlan;
export const showsInPre: (length: number) => boolean;

// formatted.ts
export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "plain"; note?: string };
export function formatText(name: string, text: string, runner?: Runner, timeoutMs?: number): Promise<Formatted>;   // never rejects

// formatrunner.ts
export type FormatJob = { kind: "markdown"; text: string };

// languages.ts
export const languageLoaders: Record<LanguageId, () => Promise<Extension>>;
export function loadLanguage(id: LanguageId): Promise<Extension>;   // rejects on a failed import or an unknown id

// codetheme.ts
export const codeTheme: Extension;
export const codeHighlight: Extension;

// editor.ts
export type EditorOptions = { text: string; language?: Extension; wrap: boolean; lineNumbers: boolean };
export type Editor = { setText(text: string): void; setLanguage(language: Extension | undefined): void; setWrap(wrap: boolean): void; setLineNumbers(on: boolean): void; destroy(): void };
export function createEditor(parent: HTMLElement, initial: EditorOptions): Editor;

// CodeView.svelte props
type Props = { text: string; language?: LanguageId; wrap?: boolean /* default true */; lineNumbers?: boolean /* default false */ };

// FormattedText.svelte props
type Props = { html: SafeHtml };
```

Marks that the browser check reads: `data-preview="rendered"` (rendered markdown), `"source"` (markdown source in CodeView), `"code"` (code in CodeView), `"plain"` (a `<pre>`, or CodeView for a large plain text), `"binary"`. Classes: `.formatted-md`, `.code-view` (the box around the editor), and CodeMirror's own `.cm-editor`, `.cm-scroller`, `.cm-content`, `.cm-line`, `.cm-lineWrapping`. Buttons with the text `Rendered`, `Source` and `Wrap` have `aria-pressed`.

## Task A: Delete highlight.js

**Files:**
- Delete: `highlight.ts`, `highlight.test.ts`, `highlightfail.test.ts`
- Modify: `viewkind.ts`, `viewkind.test.ts`, `sanitize.ts`, `sanitize.test.ts`, `formatjobs.ts`, `format.worker.ts`, `formatrunner.ts`, `formatrunner.test.ts`, `guards.ts`, `formatted.ts`, `formatted.test.ts`, `formatimports.test.ts`, `web/package.json`, `web/bun.lock`

**Interfaces:** `viewkind.ts`, `formatted.ts` and `formatrunner.ts` as in the Interfaces section.

**What not to touch:** `markdown.ts`, `markdown.test.ts`, `FormattedText` (not yet created), the markdown part of `formatjobs.ts` (`esc`, `safeHref`, the `Marked` renderer, `markdownToHtml`, `markdownToHtmlJob`), `isTooSlowToRender` and its constants in `guards.ts`, the `withTimeout` helper and `FAILED_NOTE` in `formatted.ts`, the markdown parts of every test, and `vite.config.ts` (`worker: { format: "es" }` stays).

- [ ] **Step 1: Check the starting point.** The markdown worker work must be committed. Run `git log --oneline -3` and `git status --short web`. The log must show the commit "run the library step in a worker with a 2 second limit and sanitize on the main thread" (it was `56b4bac` when this plan was written) and `git status --short web` must print nothing. If a file that this task names has uncommitted changes, stop and ask. The whole file texts below were taken from that commit. If `git diff 56b4bac -- <file>` is not empty for one of the files replaced as a whole, compare by hand and keep the markdown changes.
- [ ] **Step 2: Record the baseline.** Run `export PATH=$HOME/.bun/bin:$PATH && cd web && bun --bun vitest run src 2>&1 | tail -8`. Write down the `Tests` count (1137 in the scratch copy).
- [ ] **Step 3: Write the new viewkind test first.** Replace `viewkind.test.ts` with this text. The tests for `CODE_LIMIT` are gone. The new tests pin that code has no limit, the 64 K plain edge and the `markdown` id.

```ts
import { describe, expect, test } from "vitest";
import { LANGUAGES, MARKDOWN_LIMIT, PLAIN_PRE_LIMIT, isMarkdownName, languageFor, showsInPre, viewKind } from "./viewkind";

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
  test("LANGUAGES has 16 distinct entries: 15 that a name can pick, and markdown", () => {
    expect(LANGUAGES.length).toBe(16);
    expect(new Set(LANGUAGES).size).toBe(16);
    expect(LANGUAGES).toContain("markdown");
  });
  test("no file name picks the markdown language: markdown files have their own view", () => {
    for (const n of ["a.md", "a.markdown", "README.md"]) expect(languageFor(n), n).toBeUndefined();
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
  test("the markdown limit counts characters and is inclusive", () => {
    expect(MARKDOWN_LIMIT).toBe(102400);
    expect(viewKind("a.md", MARKDOWN_LIMIT).kind).toBe("markdown");
    expect(viewKind("a.md", MARKDOWN_LIMIT + 1).kind).toBe("plain");
  });
  test("code has no size limit: a 512 K file is still code", () => {
    expect(viewKind("a.ts", 512 * 1024)).toEqual({ kind: "code", language: "typescript" });
    expect(viewKind("a.ts", 10 * 1024 * 1024)).toEqual({ kind: "code", language: "typescript" });
    expect(viewKind("a.ts", MARKDOWN_LIMIT + 1).kind).toBe("code");
    expect(viewKind("a.md", 128 * 1024).kind).toBe("plain");
  });
  test("a too large markdown file has a note that names the limit and says characters", () => {
    expect(viewKind("a.md", MARKDOWN_LIMIT + 1)).toEqual({ kind: "plain", note: "This file has more than 100 K characters (K is 1,024), which is too many to format. It shows as plain text." });
  });
  test("a plain text shows in a pre box up to 64 K characters, inclusive", () => {
    expect(PLAIN_PRE_LIMIT).toBe(65536);
    expect(showsInPre(0)).toBe(true);
    expect(showsInPre(PLAIN_PRE_LIMIT)).toBe(true);
    expect(showsInPre(PLAIN_PRE_LIMIT + 1)).toBe(false);
  });
  test("a large file of an unknown type has no note", () => {
    expect(viewKind("big.txt", MARKDOWN_LIMIT * 2)).toEqual({ kind: "plain" });
  });
});
```

- [ ] **Step 4: See it fail.** Run `cd web && bun --bun vitest run src/lib/features/sessions/viewkind.test.ts`. It fails because `PLAIN_PRE_LIMIT` and `showsInPre` do not exist and the limits differ.
- [ ] **Step 5: Replace `viewkind.ts`.** Use this text.

```ts
// Decides how the preview shows a text file. Pure: no DOM, no libraries, so the preview page can import it without
// loading the markdown or code libraries. The language ids are the keys of the loaders in languages.ts.

/** Largest text, in characters of the string (not bytes), that is rendered as markdown. 100 K, where K is 1024. */
export const MARKDOWN_LIMIT = 100 * 1024;
/** Largest plain text, in characters of the string (not bytes), that shows in a plain pre box. A larger text shows in CodeView, which builds only the lines in view. 64 K, where K is 1024. */
export const PLAIN_PRE_LIMIT = 64 * 1024;

/** The 15 languages that a file name can pick, and "markdown", which only the Source view of a markdown file uses. */
export const LANGUAGES = ["typescript", "javascript", "json", "python", "bash", "yaml", "xml", "css", "sql", "go", "rust", "ini", "diff", "dockerfile", "makefile", "markdown"] as const;
export type LanguageId = (typeof LANGUAGES)[number];

/** Code has no size limit here. The server already cuts a preview at 512 KB, and CodeView handles that size. */
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

/** The language for a file name, or undefined. The whole name is tried first (Dockerfile, Makefile), then the extension. */
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

const TOO_LARGE = `This file has more than ${MARKDOWN_LIMIT / 1024} K characters (K is 1,024), which is too many to format. It shows as plain text.`;

/** How to show the text of a file: rendered markdown, colored code, or plain. `length` is `text.length`. */
export function viewKind(name: string, length: number): ViewPlan {
  if (isMarkdownName(name)) return length <= MARKDOWN_LIMIT ? { kind: "markdown" } : { kind: "plain", note: TOO_LARGE };
  const language = languageFor(name);
  return language === undefined ? { kind: "plain" } : { kind: "code", language };
}

/** True when a plain text shows in a pre box. A longer text shows in CodeView, so a 512 KB file does not make a giant DOM. */
export const showsInPre = (length: number): boolean => length <= PLAIN_PRE_LIMIT;
```

- [ ] **Step 6: Replace the markdown pipeline files.** Use these texts for `formatted.ts`, `formatjobs.ts`, `format.worker.ts` and `formatrunner.ts`. Each is the committed file with the code (highlight) parts cut out. Nothing else changed. After this step, `git diff` of each file must show only removed code lines, the changed comment lines, and in `formatted.ts` the new early return and the shorter `try` block.

`formatted.ts`:

```ts
// Renders markdown for the preview. The cheap checks and the size limit run here, on the main thread. The slow library
// step runs through a runner (a worker with a time limit). What the runner returns is untrusted: this file runs layer 2
// (sanitize.ts, which holds DOMPurify) on it before it makes SafeHtml. This file must not import marked. A file that is
// not markdown gives plain at once: code is shown by CodeView.svelte, not here. It never throws: any failure gives plain
// text with a note.
import { FORMAT_TIMEOUT_MS, defaultRunner, type FormatJob, type Runner } from "./formatrunner";
import { isTooSlowToRender } from "./guards";
import type { SafeHtml } from "./sanitize";
import { viewKind } from "./viewkind";

export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "plain"; note?: string };
export const FAILED_NOTE = "This file could not be formatted. It shows as plain text.";

/** Waits for `p` for `ms`. Gives undefined at the time limit, even if the runner ignores its own limit. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });

/** `name` is the file name, `text` is the preview text. The result is never an error: a failure gives plain text with a note. */
export async function formatText(name: string, text: string, runner: Runner = defaultRunner, timeoutMs: number = FORMAT_TIMEOUT_MS): Promise<Formatted> {
  const plan = viewKind(name, text.length);
  if (plan.kind !== "markdown") return plan.kind === "plain" && plan.note ? { kind: "plain", note: plan.note } : { kind: "plain" };
  try {
    if (!isTooSlowToRender(text)) {
      const job: FormatJob = { kind: "markdown", text };
      const raw = await withTimeout(runner(job, timeoutMs), timeoutMs);
      if (raw !== undefined) {
        const sanitize = await import("./sanitize");
        return { kind: "markdown", html: sanitize.sanitizeMarkdownHtml(raw) };
      }
    }
  } catch {
    // The worker failed, the time ran out, or a library threw: fall through to plain text.
  }
  return { kind: "plain", note: FAILED_NOTE };
}
```

`formatjobs.ts`:

```ts
// The slow library step (marked), with no DOM. Only the worker (format.worker.ts) and the no-Worker fallback (formatrunner.ts)
// import this file. The job gives UNTRUSTED html: the strict marked renderer is layer 1, and the caller must run layer 2
// (sanitize.ts) on the main thread. Nothing in this file makes SafeHtml.
import { Marked, type Tokens } from "marked";
import { isTooSlowToRender } from "./guards";

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

/** Markdown to untrusted html, or undefined when the text is too slow to render or marked throws (a stack overflow). */
export function markdownToHtmlJob(text: string): string | undefined {
  try {
    if (isTooSlowToRender(text)) return undefined;
    return markdownToHtml(text);
  } catch {
    return undefined;
  }
}
```

`format.worker.ts`:

```ts
// The worker. It runs one job and posts the untrusted html back. It never throws out of the handler. The main thread
// sanitizes what it gets, so nothing from here reaches the page without layer 2.
import { markdownToHtmlJob } from "./formatjobs";
import type { FormatJob } from "./formatrunner";

self.onmessage = async (e: MessageEvent) => {
  const { id, job } = (e.data ?? {}) as { id?: number; job?: FormatJob };
  try {
    if (!job || job.kind !== "markdown") throw new Error("bad job");
    const html = markdownToHtmlJob(job.text);
    self.postMessage({ id, html });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
```

`formatrunner.ts`:

```ts
// Runs the slow library step with a time limit. The default runner makes a module worker for each call and ends it when
// the result arrives or the time is up, so a hostile file cannot freeze the page: the worker is stopped. The result is
// untrusted html or undefined. Without Worker (vitest, old browsers) the job runs in this process, and only the cheap
// guards protect the page. This file must not name marked: formatjobs.ts is loaded only by the worker and
// by that fallback.
export type FormatJob = { kind: "markdown"; text: string };
/** Gives untrusted html, or undefined when the job failed or took too long. Never trust the string: sanitize it. */
export type Runner = (job: FormatJob, timeoutMs: number) => Promise<string | undefined>;
/** The most time one job may take. After this the worker is stopped and the file shows as plain text. */
export const FORMAT_TIMEOUT_MS = 2000;

/** Runs the job in this process. Used when there is no Worker, and by tests. */
export async function runInProcess(job: FormatJob): Promise<string | undefined> {
  const jobs = await import("./formatjobs");
  return jobs.markdownToHtmlJob(job.text);
}

let nextId = 1;

export const defaultRunner: Runner = (job, timeoutMs = FORMAT_TIMEOUT_MS) => {
  if (typeof Worker === "undefined") return runInProcess(job).catch(() => undefined);
  return new Promise((resolve) => {
    const id = nextId++;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (html: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        worker?.terminate();
      } catch {
        // Nothing more to do.
      }
      resolve(html);
    };
    try {
      worker = new Worker(new URL("./format.worker.ts", import.meta.url), { type: "module" });
      timer = setTimeout(() => finish(undefined), timeoutMs);
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { id?: number; html?: unknown } | null;
        if (!d || d.id !== id) return;
        finish(typeof d.html === "string" ? d.html : undefined);
      };
      worker.onerror = () => finish(undefined);
      worker.onmessageerror = () => finish(undefined);
      worker.postMessage({ id, job });
    } catch {
      finish(undefined);
    }
  });
};
```

- [ ] **Step 7: Cut `hasLongWordRun` from `guards.ts`.** Delete the last block of the file: the comment line that starts `/** Most characters in a row that are letters`, `MAX_WORD_RUN` and `hasLongWordRun`. In the top comment, change `The libraries (marked and highlight.js) are slow` to `The library (marked) is slow`. The diff is:

```diff
@@ -1,5 +1,5 @@
 // Cheap checks that run before any library. Pure: no DOM, no libraries, so the preview page can import them. The
-// libraries (marked and highlight.js) are slow on some small-looking inputs, and no list of bad inputs can bound the
+// library (marked) is slow on some small-looking inputs, and no list of bad inputs can bound the
 // time, so the real bound is the worker timeout in formatrunner.ts. These checks only refuse the known worst cases early.
 
 // Pre-scan limits. marked is slow on some small-looking inputs: a long run of * or _ is quadratic in its emphasis scan
@@ -55,18 +55,3 @@ export function isTooSlowToRender(text: string): boolean {
   }
   return false;
 }
-
-/** Most characters in a row that are letters, digits, underscore, dollar or hyphen. highlight.js is quadratic on a long run. */
-export const MAX_WORD_RUN = 511;
-
-/** True when the text has a run of 512 or more word characters in a row. One pass, no backtracking. */
-export function hasLongWordRun(text: string): boolean {
-  let run = 0;
-  for (let i = 0; i < text.length; i++) {
-    const c = text.charCodeAt(i);
-    const word = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c === 45;
-    run = word ? run + 1 : 0;
-    if (run > MAX_WORD_RUN) return true;
-  }
-  return false;
-}
```

- [ ] **Step 8: Replace `sanitize.ts`.** Use this text. It is the committed file without the code sanitizer.

```ts
// The second layer of the safety rules for rendered markdown. The function takes HTML text and gives back SafeHtml.
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
  } else {
    // ALLOWED_ATTR is global, so href and title would stay on any allowed tag. They belong on links only.
    node.removeAttribute("href");
    node.removeAttribute("title");
  }
});
// class is never allowed in markdown output. ALLOWED_ATTR leaves it out; this stays as a second guard.
markdownPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class") data.keepAttr = false;
});

/** Markdown output: fixed tags, only `href` and `title` on links, only http, https and mailto addresses. No `class`, no `style`, no handlers. */
export function sanitizeMarkdownHtml(html: string): SafeHtml {
  const fragment = markdownPurify.sanitize(html, {
    ALLOWED_TAGS: [...MARKDOWN_TAGS],
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_URI_REGEXP: URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    RETURN_DOM_FRAGMENT: true,
  });
  if (!fragment) return "" as SafeHtml; // DOMPurify gives no fragment when nothing is left
  // A link that lost its href (javascript:, data:, a bad scheme) is not a link: keep its content, drop the tag.
  for (const a of Array.from(fragment.querySelectorAll("a:not([href])"))) a.replaceWith(...Array.from(a.childNodes));
  const box = document.createElement("div");
  box.appendChild(fragment);
  return box.innerHTML as SafeHtml;
}
```

- [ ] **Step 9: Edit `sanitize.test.ts`.** Apply this diff. The `sanitizeCodeHtml` tests go. A smaller class rule test stays, so a future change that allows `class` in markdown fails.

```diff
@@ -1,6 +1,6 @@
 // @vitest-environment jsdom
 import { describe, expect, test } from "vitest";
-import { sanitizeCodeHtml, sanitizeMarkdownHtml } from "./sanitize";
+import { sanitizeMarkdownHtml } from "./sanitize";
 
 const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
 
@@ -52,40 +52,10 @@ describe("sanitizeMarkdownHtml (second layer, fed raw hostile HTML)", () => {
   });
 });
 
-describe("sanitizeCodeHtml", () => {
-  test("keeps span and class and nothing else", () => {
-    const out = doc(sanitizeCodeHtml("<span class=\"hljs-keyword\" onclick=\"1\" style=\"x:y\">a</span><a href=\"https://ok.example\">l</a><img src=x onerror=1><script>1</script>"));
-    expect(Array.from(out.body.querySelectorAll("*")).map((e) => e.tagName.toLowerCase())).toEqual(["span"]);
-    const s = out.querySelector("span")!;
-    expect(Array.from(s.attributes).map((a) => a.name)).toEqual(["class"]);
-    expect(s.className).toBe("hljs-keyword");
-  });
-});
-
-describe("class rule (hljs tokens only, and never in markdown)", () => {
+describe("class rule (never in markdown)", () => {
   const classes = (html: string) => Array.from(doc(html).body.querySelectorAll("*")).map((e) => e.getAttribute("class"));
-  test("the code sanitizer drops class values that have no hljs token", () => {
-    for (const bad of ["fixed inset-0 z-50 bg-white", "x\" onclick=\"alert(1)", "HLJS-KEYWORD", "", "   ", "language-ts", "language-javascript", "hljs--x", "hljs-", "onclick=alert(1)", "a'b", "fixed_x"]) {
-      expect(classes(sanitizeCodeHtml(`<span class="${bad.replace(/"/g, "&quot;")}">a</span>`)), bad).toEqual([null]);
-    }
-  });
-  test("the code sanitizer filters token by token", () => {
-    expect(classes(sanitizeCodeHtml('<span class="hljs-keyword fixed">a</span>'))).toEqual(["hljs-keyword"]);
-    expect(classes(sanitizeCodeHtml('<span class="hljs-keyword language-ts hljs-string">a</span>'))).toEqual(["hljs-keyword hljs-string"]);
-    expect(classes(sanitizeCodeHtml('<span class="hljs-keyword onclick=alert(1)">a</span>'))).toEqual(["hljs-keyword"]);
-    expect(classes(sanitizeCodeHtml('<span class="hljs-keyword a&quot;b">a</span>'))).toEqual(["hljs-keyword"]);
-  });
-  test("the code sanitizer keeps hljs tokens and the highlight.js modifier words", () => {
-    expect(classes(sanitizeCodeHtml('<span class="hljs-keyword hljs-string">a</span><span class="hljs">b</span><span class="hljs-title_ hljs-attr">c</span>'))).toEqual(["hljs-keyword hljs-string", "hljs", "hljs-title_ hljs-attr"]);
-    expect(classes(sanitizeCodeHtml('<span class="hljs-title function_">a</span><span class="hljs-title class_ inherited__">b</span><span class="hljs-title function_ invoke__">c</span><span class="hljs-subst language_">d</span>'))).toEqual(["hljs-title function_", "hljs-title class_ inherited__", "hljs-title function_ invoke__", "hljs-subst language_"]);
-  });
-  test("real highlight.js output keeps function and class name colors", async () => {
-    const { highlightCode } = await import("./highlight");
-    expect(await highlightCode("function f(){}", "javascript")).toContain("function_");
-    expect(await highlightCode("class A { f() {} }", "typescript")).toContain("class_");
-  });
   test("the markdown sanitizer never keeps class", () => {
-    expect(classes(sanitizeMarkdownHtml('<p class="hljs-keyword">a</p><code class="hljs">b</code><a class="x" href="https://ok.example">c</a>'))).toEqual([null, null, null]);
+    expect(classes(sanitizeMarkdownHtml('<p class="keyword">a</p><code class="hljs">b</code><a class="x" href="https://ok.example">c</a>'))).toEqual([null, null, null]);
   });
 });
```

- [ ] **Step 10: Edit the other tests.** Replace `formatted.test.ts` with this text.

```ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { FAILED_NOTE, formatText } from "./formatted";
import { runInProcess, type FormatJob, type Runner } from "./formatrunner";
import { MARKDOWN_LIMIT } from "./viewkind";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
const fixed = (html: string): Runner => async () => html;
const calls = () => {
  const jobs: FormatJob[] = [];
  const runner: Runner = async (job) => { jobs.push(job); return "<p>x</p>"; };
  return { jobs, runner };
};
const boom: Runner = () => Promise.reject(new Error("offline"));
const hang: Runner = () => new Promise<string | undefined>(() => {});

describe("formatText", () => {
  test("markdown uses the runner and the result is sanitized on the main thread", async () => {
    expect(await formatText("a.md", "# x", fixed("<p>x</p>"))).toEqual({ kind: "markdown", html: "<p>x</p>" });
  });
  test("the job names the kind and the text", async () => {
    const { jobs, runner } = calls();
    await formatText("a.md", "# x", runner);
    expect(jobs).toEqual([{ kind: "markdown", text: "# x" }]);
  });
  test("a file that is not markdown never calls the runner: code is shown by CodeView", async () => {
    const { jobs, runner } = calls();
    expect(await formatText("a.txt", "x", runner)).toEqual({ kind: "plain" });
    expect(await formatText("a.ts", "let a", runner)).toEqual({ kind: "plain" });
    expect(jobs).toEqual([]);
  });
  test("a too large markdown file never calls the runner and carries the note", async () => {
    const { jobs, runner } = calls();
    const md = await formatText("a.md", "x".repeat(MARKDOWN_LIMIT + 1), runner);
    expect(md.kind).toBe("plain");
    expect(md.kind === "plain" && md.note).toContain("100 K characters");
    expect(jobs).toEqual([]);
  });
  test("a markdown file exactly at the limit is rendered", async () => {
    expect((await formatText("a.md", "x".repeat(MARKDOWN_LIMIT), fixed("<p>x</p>"))).kind).toBe("markdown");
  });
  test("a runner that fails, or gives undefined, gives plain text with a note and does not throw", async () => {
    expect(await formatText("a.md", "# x", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.md", "# x", async () => undefined)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.md", "# x", () => { throw new Error("sync"); })).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
  test("a runner that never answers gives plain text with the note after the timeout", async () => {
    const start = performance.now();
    expect(await formatText("a.md", "# x", hang, 50)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(performance.now() - start).toBeLessThan(2000);
  });
  test("a runner that rejects after the timeout causes no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    const late: Runner = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 80));
    expect(await formatText("a.md", "# x", late, 20)).toEqual({ kind: "plain", note: FAILED_NOTE });
    await new Promise((r) => setTimeout(r, 150));
    process.off("unhandledRejection", on);
    expect(unhandled).toEqual([]);
  });
});

describe("the worker output is untrusted: the main thread sanitizes it", () => {
  const HOSTILE = "<p>a</p><script>alert(1)</script><img src=x onerror=alert(1)><a href=\"javascript:alert(1)\" onclick=\"x\">l</a><span class=\"fixed inset-0\">s</span><iframe src=x></iframe>";
  test("markdown", async () => {
    const r = await formatText("a.md", "x", fixed(HOSTILE));
    expect(r.kind).toBe("markdown");
    const d = doc(r.kind === "markdown" ? r.html : "");
    expect(d.querySelectorAll("script, img, iframe, span").length).toBe(0);
    expect(d.querySelectorAll("[onclick], [onerror], [class]").length).toBe(0);
    expect(Array.from(d.querySelectorAll("a")).every((a) => !a.hasAttribute("href") || /^https?:|^mailto:/.test(a.getAttribute("href")!))).toBe(true);
    expect(d.body.querySelector("a[href^='javascript']")).toBeNull();
  });
});

describe("the cheap guards run on the main thread before any runner", () => {
  test("a long run of emphasis marks is plain at once", async () => {
    const { jobs, runner } = calls();
    expect(await formatText("a.md", "*".repeat(300), runner)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(jobs).toEqual([]);
  });
  // 34133 and 51200 repeats are the largest that fit in MARKDOWN_LIMIT (100 K characters). A bigger one is refused by the limit.
  test("mixed delimiters pass the pre-scan, and the timeout covers them", async () => {
    for (const src of ["*a_".repeat(34133), "_a".repeat(51200)]) {
      const { jobs, runner } = calls();
      expect((await formatText("a.md", src, runner)).kind).toBe("markdown");
      expect(jobs.length).toBe(1);
      expect(await formatText("a.md", src, hang, 50)).toEqual({ kind: "plain", note: FAILED_NOTE });
    }
  });
});

describe("with the real jobs run in this process", () => {
  test("a script link and an image handler are removed from markdown", async () => {
    const r = await formatText("a.md", "[x](javascript:1)\n\n<img src=x onerror=1>\n\n[ok](https://example.com)", runInProcess);
    expect(r.kind).toBe("markdown");
    const d = doc(r.kind === "markdown" ? r.html : "");
    expect(d.querySelectorAll("img, script, [onerror]").length).toBe(0);
    expect(Array.from(d.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(d.body.textContent).toContain("<img src=x onerror=1>");
  });
});
```

  Apply these diffs to `formatrunner.test.ts` and `formatimports.test.ts`. In `formatrunner.test.ts` the worker test now expects that a job of another kind gets an error answer.

```diff
@@ -113,14 +113,12 @@ describe("defaultRunner with a fake Worker", () => {
 });
 
 describe("without Worker (vitest and old browsers) the job runs in this process", () => {
-  test("markdown and code give layer 1 html", async () => {
+  test("markdown gives layer 1 html", async () => {
     vi.stubGlobal("Worker", undefined);
     expect(await defaultRunner({ kind: "markdown", text: "# x" }, 1000)).toContain("<h1>");
-    expect(await defaultRunner({ kind: "code", text: "const a = 1;", language: "typescript" }, 1000)).toContain("hljs-keyword");
     expect(FakeWorker.instances).toHaveLength(0);
   });
   test("the guards still apply", async () => {
-    expect(await runInProcess({ kind: "code", text: "a".repeat(5000), language: "typescript" })).toBeUndefined();
     expect(await runInProcess({ kind: "markdown", text: "*".repeat(400) })).toBeUndefined();
   });
 });
@@ -133,12 +131,12 @@ describe("format.worker", () => {
     await import("./format.worker");
     const onmessage = (self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage;
     await onmessage({ data: { id: 1, job: { kind: "markdown", text: "# x" } } });
-    await onmessage({ data: { id: 2, job: { kind: "code", text: "let a", language: "typescript" } } });
+    await onmessage({ data: { id: 2, job: { kind: "code", text: "let a", language: "typescript" } } }); // a job of another kind is refused
     await onmessage({ data: { id: 3, job: { kind: "nope" } } });
     await onmessage({ data: null });
     expect(posted[0]).toMatchObject({ id: 1 });
     expect((posted[0] as { html: string }).html).toContain("<h1>");
-    expect((posted[1] as { html: string }).html).toContain("hljs-keyword");
+    expect(posted[1]).toMatchObject({ id: 2, error: expect.any(String) });
     expect(posted[2]).toMatchObject({ id: 3, error: expect.any(String) });
     expect(posted[3]).toMatchObject({ error: expect.any(String) });
   });
```

```diff
@@ -2,7 +2,7 @@ import { readFileSync } from "node:fs";
 import { join } from "node:path";
 import { describe, expect, test } from "vitest";
 
-// The main thread must not load marked or highlight.js: only the worker (and the no-Worker fallback, through formatjobs)
+// The main thread must not load marked: only the worker (and the no-Worker fallback, through formatjobs)
 // does. These files are the ones the preview page loads, so they must not name the libraries.
 const read = (file: string) => readFileSync(join(process.cwd(), "src/lib/features/sessions", file), "utf8");
 const importLines = (file: string) =>
@@ -10,12 +10,12 @@ const importLines = (file: string) =>
     .split("\n")
     .filter((l) => /^\s*(import|export)\b.*\bfrom\b|\bimport\s*\(/.test(l) || /^\s*import\s+["']/.test(l));
 
-describe("the main thread files do not import marked or highlight.js", () => {
+describe("the main thread files do not import marked", () => {
   for (const file of ["formatted.ts", "formatrunner.ts", "sanitize.ts", "viewkind.ts", "guards.ts"]) {
     test(file, () => {
       const lines = importLines(file);
-      for (const l of lines) expect(l, `${file}: ${l}`).not.toMatch(/["'](marked|highlight\.js)(\/[^"']*)?["']/);
-      const banned = file === "formatrunner.ts" ? /\.\/(markdown|highlight)["']/ : /\.\/(markdown|highlight|formatjobs)["']/;
+      for (const l of lines) expect(l, `${file}: ${l}`).not.toMatch(/["']marked(\/[^"']*)?["']/);
+      const banned = file === "formatrunner.ts" ? /\.\/markdown["']/ : /\.\/(markdown|formatjobs)["']/;
       for (const l of lines) expect(l, `${file}: ${l}`).not.toMatch(banned);
     });
   }
@@ -24,8 +24,8 @@ describe("the main thread files do not import marked or highlight.js", () => {
     expect(src.match(/import\("\.\/formatjobs"\)/g)).toHaveLength(1);
     expect(src).toContain("format.worker");
   });
-  test("only formatjobs.ts imports the libraries", () => {
-    const withLib = ["formatjobs.ts", "markdown.ts", "highlight.ts", "format.worker.ts"].filter((f) => importLines(f).some((l) => /["'](marked|highlight\.js)/.test(l)));
+  test("only formatjobs.ts imports marked", () => {
+    const withLib = ["formatjobs.ts", "markdown.ts", "format.worker.ts"].filter((f) => importLines(f).some((l) => /["']marked/.test(l)));
     expect(withLib).toEqual(["formatjobs.ts"]);
   });
 });
```

- [ ] **Step 11: Delete the files and the dependency.** Run:

```bash
export PATH=$HOME/.bun/bin:$PATH
git rm web/src/lib/features/sessions/highlight.ts web/src/lib/features/sessions/highlight.test.ts web/src/lib/features/sessions/highlightfail.test.ts
cd web && bun remove highlight.js
cd .. && grep -rn "highlight\.js\|hljs\|CODE_LIMIT\|codeToHtml\|sanitizeCode\|hasLongWordRun\|grammarLoaders\|highlightCode" web/src web/test web/package.json web/vite.config.ts
```

  The `grep` must print nothing, except one `hljs` word that is inside a payload string of `sanitize.test.ts` (the `class="hljs-keyword"` in the hostile list). That payload stays, because it proves that `class` is removed from markdown.
- [ ] **Step 12: Run all checks.**

```bash
export PATH=$HOME/.bun/bin:$PATH
bun run --cwd web check
(cd web && bun --bun vitest run src 2>&1 | tail -8)
(cd web && bun install --frozen-lockfile 2>&1 | tail -2)
bun install --frozen-lockfile 2>&1 | tail -2
bun run --cwd web build 2>&1 | tail -3
```

  `svelte-check` has 0 errors. The tests are green. The scratch copy reports `Tests 1077`, which is 60 less than the baseline, because the `highlight.js` tests, the code sanitizer tests and the long word run tests are gone. Both frozen installs print `no changes`. The build ends with `done`. `web/dist` must not contain `registerLanguage` (`grep -rl registerLanguage web/dist | wc -l` prints `0`).
- [ ] **Step 13: Commit.**

```bash
git add -A web/src web/package.json web/bun.lock
git commit -m "refactor(web): remove highlight.js, its sanitizer and the code job of the worker"
```

## Task B: CodeMirror dependencies and the language loader

**Files:**
- Modify: `web/package.json`, `web/bun.lock`
- Create: `web/src/lib/features/sessions/languages.ts`, `web/src/lib/features/sessions/languages.test.ts`

**Interfaces:** `languageLoaders`, `loadLanguage` (see Interfaces). `languageFor` and the extension map stay in `viewkind.ts` and do not change in this task.

Which package each language uses, and why:

| id | Package | Note |
| --- | --- | --- |
| typescript, javascript | `@codemirror/lang-javascript` | `jsx: true` for both, so `.tsx`, `.jsx` and Svelte script parse. The parser is error tolerant. |
| json | `@codemirror/lang-json` | |
| python | `@codemirror/lang-python` | |
| yaml | `@codemirror/lang-yaml` | official package, exists |
| xml (HTML, XML, SVG, Svelte, Vue) | `@codemirror/lang-html` | The id keeps its old name `xml`. `lang-html` also colors script and style in the file. |
| css | `@codemirror/lang-css` | |
| sql | `@codemirror/lang-sql` | |
| go | `@codemirror/lang-go` | official package, exists |
| rust | `@codemirror/lang-rust` | official package, exists |
| markdown | `@codemirror/lang-markdown` | with the GFM base (`markdownLanguage`), so tables and task lists color |
| bash | legacy mode `shell` | no official package |
| ini, toml | legacy mode `toml` | handles `[section]` and `key = value`. A `;` comment of an INI file is not colored. |
| diff | legacy mode `diff` | no official package |
| dockerfile | legacy mode `dockerFile` | |
| makefile | legacy mode `shell` | `@codemirror/legacy-modes` has no Makefile mode. The shell mode colors comments, strings and `$(VARS)`. |

`@codemirror/commands` is not needed: the view is read-only and has no key map. `@lezer/highlight` is added as a direct dependency, because `codetheme.ts` and the tests import `tags` and `classHighlighter` from it.

- [ ] **Step 1: Add the dependencies.** Run:

```bash
export PATH=$HOME/.bun/bin:$PATH
cd web
bun add @codemirror/state @codemirror/view @codemirror/language @lezer/highlight @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-python @codemirror/lang-yaml @codemirror/lang-html @codemirror/lang-css @codemirror/lang-sql @codemirror/lang-go @codemirror/lang-rust @codemirror/lang-markdown @codemirror/legacy-modes
```

  All must be under `dependencies` with `^` ranges. When this plan was written, `bun add` wrote: state `^6.7.6`, view `^6.43.15`, language `^6.13.1`, `@lezer/highlight ^1.2.5`, lang-javascript `^6.2.5`, lang-json `^6.0.2`, lang-python `^6.2.1`, lang-yaml `^6.1.3`, lang-html `^6.4.12`, lang-css `^6.3.1`, lang-sql `^6.10.0`, lang-go `^6.0.1`, lang-rust `^6.0.2`, lang-markdown `^6.5.2`, legacy-modes `^6.5.5`. Keep what `bun add` writes.
- [ ] **Step 2: Write the test first.** Create `languages.test.ts`. It loads every language, builds a read-only editor state, parses a real sample and requires at least one colored token, so an empty extension fails. It also checks that the loader keys equal `LANGUAGES`.

```ts
import { ensureSyntaxTree, language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, test } from "vitest";
import { languageLoaders, loadLanguage } from "./languages";
import { LANGUAGES, languageFor, type LanguageId } from "./viewkind";

// A short real sample for each language. Each must give at least one colored token, which proves that the loaded
// language does something and is not an empty extension.
const SAMPLES: Record<LanguageId, string> = {
  typescript: "export function f(a: number): string { return \"x\" + a; } // note\n",
  javascript: "const a = () => <div className=\"x\">{1}</div>; // note\n",
  json: "{\"a\": [1, true, null, \"s\"]}\n",
  python: "def f(a):\n    return \"x\" + str(1)  # note\n",
  bash: "#!/bin/sh\nif [ -n \"$A\" ]; then echo \"hi $(date)\"; fi # note\n",
  yaml: "# note\nname: demo\nitems:\n  - a: 1\n    b: \"two\"\n",
  xml: "<!-- note -->\n<div class=\"a\"><script>let a = 1;</script></div>\n",
  css: "/* note */\n.a > b:hover { color: #fff; margin: 1px 2em; }\n",
  sql: "-- note\nSELECT a, count(*) FROM t WHERE b = 'x' GROUP BY a;\n",
  go: "package main\n\n// note\nfunc main() { x := \"s\"; println(x, 1) }\n",
  rust: "// note\nfn main() { let x: u8 = 1; println!(\"{}\", x); }\n",
  ini: "# note\n[section]\nkey = \"value\"\nn = 12\n",
  diff: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n",
  dockerfile: "# note\nFROM node:22\nRUN echo \"hi\" && npm ci\n",
  makefile: "# note\nall: build\n\t@echo \"$(CC)\"\n",
  markdown: "# Title\n\nSome *emphasis*, `code` and [a link](https://example.com).\n\n- item\n",
};

const classesOf = (state: EditorState): Set<string> => {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  expect(tree).not.toBeNull();
  const found = new Set<string>();
  highlightTree(tree!, classHighlighter, (_from, _to, cls) => found.add(cls));
  return found;
};

describe("languageLoaders", () => {
  test("have exactly the ids of LANGUAGES", () => {
    expect(Object.keys(languageLoaders).sort()).toEqual([...LANGUAGES].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...LANGUAGES].sort());
  });
  test.each(LANGUAGES)("%s loads and builds a read-only editor state that colors its sample", async (id) => {
    const ext = await loadLanguage(id);
    const state = EditorState.create({ doc: SAMPLES[id], extensions: [EditorState.readOnly.of(true), ext] });
    expect(state.readOnly).toBe(true);
    expect(state.facet(language)).not.toBeNull();
    expect(state.doc.toString()).toBe(SAMPLES[id]);
    expect(classesOf(state).size, `${id} gave no colored token`).toBeGreaterThan(0);
  });
  test("a sample gives comment, string and keyword colors in the languages that have all three", async () => {
    for (const id of ["typescript", "python", "go", "rust", "sql"] as const) {
      const state = EditorState.create({ doc: SAMPLES[id], extensions: [await loadLanguage(id)] });
      const found = classesOf(state);
      for (const c of ["tok-comment", "tok-string", "tok-keyword"]) expect(found.has(c), `${id} lacks ${c}`).toBe(true);
    }
  });
  test("every file name of the extension map has a loader", () => {
    for (const name of ["a.ts", "a.tsx", "a.js", "a.json", "a.py", "a.sh", "a.yml", "a.html", "a.svelte", "a.css", "a.sql", "a.go", "a.rs", "a.toml", "a.diff", "Dockerfile", "Makefile"]) {
      const id = languageFor(name);
      expect(id, name).toBeDefined();
      expect(typeof languageLoaders[id!], name).toBe("function");
    }
  });
  test("an unknown id rejects, and names such as constructor do not match an object key", async () => {
    for (const bad of ["nope", "constructor", "__proto__", "toString"]) await expect(loadLanguage(bad as LanguageId)).rejects.toThrow(/unknown language/);
  });
});
```

- [ ] **Step 3: See it fail.** Run `cd web && bun --bun vitest run src/lib/features/sessions/languages.test.ts`. It fails because `./languages` does not exist.
- [ ] **Step 4: Write `languages.ts`.** Use this text. It has no static import of CodeMirror except `import type`. Each `import()` is a separate chunk. `Object.hasOwn` stops a name such as `constructor` from matching an object key.

```ts
// The language loader for CodeView. Each language is its own dynamic import, so it is its own chunk, and none of them is in
// the first page load. This file imports CodeMirror only as types: every real import is an import() call. The ids are the
// LANGUAGES of viewkind.ts. An official @codemirror/lang-* package is used where one exists. A legacy mode (a small stream
// parser from @codemirror/legacy-modes) is used for INI and TOML, shell, diff and Dockerfile. Makefile has no mode of its
// own, so it uses the shell mode, which colors comments, strings, and $(VARIABLES).
import type { StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { LanguageId } from "./viewkind";

type Loader = () => Promise<Extension>;

const stream = async (mode: Promise<StreamParser<unknown>>): Promise<Extension> => {
  const [{ StreamLanguage }, parser] = await Promise.all([import("@codemirror/language"), mode]);
  return StreamLanguage.define(parser);
};

/** One loader for each language of viewkind.ts. A test replaces a loader to simulate a failed import. */
export const languageLoaders: Record<LanguageId, Loader> = {
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  bash: () => stream(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  xml: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  ini: () => stream(import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)),
  diff: () => stream(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)),
  dockerfile: () => stream(import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)),
  makefile: () => stream(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  markdown: async () => {
    const md = await import("@codemirror/lang-markdown");
    return md.markdown({ base: md.markdownLanguage });
  },
};

/** The CodeMirror extension for a language. Rejects when the import fails (for example offline) or the id is unknown. */
export function loadLanguage(id: LanguageId): Promise<Extension> {
  return Object.hasOwn(languageLoaders, id) ? languageLoaders[id]() : Promise.reject(new Error(`unknown language: ${id}`));
}
```

- [ ] **Step 5: See it pass.** Run the command of Step 3. All 20 tests pass.
- [ ] **Step 6: Prove the lock file.** Run:

```bash
export PATH=$HOME/.bun/bin:$PATH
(cd web && bun install --frozen-lockfile 2>&1 | tail -2)
bun install --frozen-lockfile 2>&1 | tail -2
git status --short bun.lock
```

  Both installs print `no changes`. The root `bun.lock` is not in the status output.
- [ ] **Step 7: Run the checks and look at the chunks.** `bun run --cwd web check` has 0 errors. `cd web && bun --bun vitest run src` is green. Nothing imports `languages.ts` yet, so the build has not changed. Write the two bundle scripts that Task E also uses: copy `chunks.ts` and `initcheck.ts` (texts in Task E, Step 2) to `/tmp/fpcheck`. They are not part of the repo.
- [ ] **Step 8: Commit.**

```bash
git add web/package.json web/bun.lock web/src/lib/features/sessions/languages.ts web/src/lib/features/sessions/languages.test.ts
git commit -m "feat(web): add CodeMirror packages and a lazy loader for 16 languages"
```

## Task C: The CodeView component

**Files:**
- Create: `codetheme.ts`, `editor.ts`, `CodeView.svelte`, `CodeView.test.ts`, `CodeViewfail.test.ts`, `CodeViewlang.test.ts`, `reactiveprops.svelte.ts` (all in `web/src/lib/features/sessions`)

**Interfaces:** `codeTheme`, `codeHighlight`, `createEditor`, `Editor`, and the `CodeView` props (see Interfaces).

Decisions, with the reason:

- **Height:** the editor grows with the page (no vertical scroll box). See Review Focus. The old `<pre>` did the same, and the Download button stays below the code.
- **Selection:** `EditorView.editable.of(false)` sets `contenteditable="false"`. The browser keeps native selection, so long press, handles and copy work. The editor draws no selection of its own.
- **Theme:** the colors are `var(--tok-...)`, defined on the editor element from `var(--primary)`, `var(--ok)`, `var(--warn)`, `var(--foreground)`, `var(--muted-foreground)` and `var(--destructive)`. They are the same six colors that were checked for contrast in the earlier plan. The box (border, radius, `bg-card`) is the Tailwind classes on the `.code-view` wrapper. The editor background is transparent.
- **Language changes:** the language loads in its own effect, so a slow or failed language never holds the text back. A changed text builds a new editor state (`setState`), which resets the selection and scroll. A changed language, wrap or line numbers use a `Compartment` and keep the state.

- [ ] **Step 1: Write the test helper.** Svelte runes work only in `.svelte.ts` files, so tests that change props need this file.

```ts
// A test helper: props that a mounted component sees change. `$state` works only in .svelte.ts files, so tests get it here.
export function reactiveProps<T extends object>(initial: T): T {
  const props = $state(initial);
  return props;
}
```

- [ ] **Step 2: Write the tests first.** `CodeView.test.ts` covers what jsdom can: mounting, the first lines, read-only, the wrap class (on by default, toggled), line numbers, a new text, a language that adds colored spans and removes them, hostile text, a 100,000 line text that builds fewer than 500 lines, `destroy` called once for each of 20 editors (so no leak), and an unmount before the editor loaded.

```ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, test, vi } from "vitest";
import CodeView from "./CodeView.svelte";
import { reactiveProps } from "./reactiveprops.svelte";

// jsdom has no layout. It can test mounting, text, classes and destroy. It cannot test heights, scrolling, wrapping on
// screen, selection, colors as painted, or theme switches. The real browser check (Playwright) covers those.
const mounted: { target: HTMLElement; c: ReturnType<typeof mount> }[] = [];
function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: props as never });
  mounted.push({ target, c });
  return { target, c };
}
afterEach(() => {
  for (const { target, c } of mounted.splice(0)) {
    try { unmount(c); } catch { /* already unmounted */ }
    target.remove();
  }
});
const ready = (target: HTMLElement) => vi.waitFor(() => expect(target.querySelector(".cm-content")).not.toBeNull());
const lines = (target: HTMLElement) => Array.from(target.querySelectorAll(".cm-line")).map((l) => l.textContent);

test("mounts and shows the first lines as text", async () => {
  const { target } = show({ text: "line one\nline two\nline three", language: "typescript" });
  await ready(target);
  expect(lines(target)).toEqual(["line one", "line two", "line three"]);
});

test("the view is read-only: no editing, no caret", async () => {
  const { target } = show({ text: "a" });
  await ready(target);
  const content = target.querySelector<HTMLElement>(".cm-content")!;
  expect(content.getAttribute("contenteditable")).toBe("false");
  expect(content.getAttribute("aria-readonly")).toBe("true");
});

test("the wrap prop turns the lineWrapping class on and off, and wrap is on by default", async () => {
  const props = reactiveProps({ text: "a b c", wrap: undefined as boolean | undefined });
  const { target } = show(props);
  await ready(target);
  const content = () => target.querySelector(".cm-content")!;
  expect(content().classList.contains("cm-lineWrapping")).toBe(true);
  props.wrap = false;
  flushSync();
  expect(content().classList.contains("cm-lineWrapping")).toBe(false);
  props.wrap = true;
  flushSync();
  expect(content().classList.contains("cm-lineWrapping")).toBe(true);
});

test("line numbers are off by default and the prop turns them on", async () => {
  const props = reactiveProps({ text: "a\nb", lineNumbers: undefined as boolean | undefined });
  const { target } = show(props);
  await ready(target);
  expect(target.querySelector(".cm-gutters")).toBeNull();
  props.lineNumbers = true;
  flushSync();
  expect(target.querySelector(".cm-lineNumbers")).not.toBeNull();
});

test("a new text replaces the old one", async () => {
  const props = reactiveProps({ text: "old" });
  const { target } = show(props);
  await ready(target);
  props.text = "new one\nnew two";
  flushSync();
  expect(lines(target)).toEqual(["new one", "new two"]);
});

test("a language adds colored spans, and a change of language changes them", async () => {
  const props = reactiveProps({ text: "const a = 1; // note", language: "typescript" as string | undefined });
  const { target } = show(props);
  await ready(target);
  await vi.waitFor(() => expect(target.querySelectorAll(".cm-line span").length).toBeGreaterThan(0));
  props.language = undefined;
  await vi.waitFor(() => expect(target.querySelectorAll(".cm-line span").length).toBe(0));
});

test("hostile text is shown as text and creates no element", async () => {
  const src = "<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<a href=\"javascript:alert(1)\">x</a>";
  const { target } = show({ text: src, language: "xml" });
  await ready(target);
  await vi.waitFor(() => expect(target.querySelectorAll(".cm-line span").length).toBeGreaterThan(0));
  expect(target.querySelectorAll("script, img, a, iframe").length).toBe(0);
  expect(lines(target).join("\n")).toBe(src);
});

test("a long file builds only the lines in view", async () => {
  const text = Array.from({ length: 100000 }, (_, i) => `line ${i}`).join("\n");
  const { target } = show({ text });
  await ready(target);
  expect(target.querySelectorAll(".cm-line").length).toBeLessThan(500);
  expect(lines(target)[0]).toBe("line 0");
});

test("unmount calls destroy once for each editor, so opening many previews leaks nothing", async () => {
  const destroy = vi.spyOn(EditorView.prototype, "destroy");
  for (let i = 0; i < 20; i++) {
    const { target, c } = show({ text: `file ${i}` });
    await ready(target);
    unmount(c);
    expect(target.querySelector(".cm-editor")).toBeNull();
  }
  expect(destroy).toHaveBeenCalledTimes(20);
  expect(document.querySelector(".cm-editor")).toBeNull();
  destroy.mockRestore();
});

test("unmount before the editor has loaded builds no editor at all", async () => {
  const destroy = vi.spyOn(EditorView.prototype, "destroy");
  const { target, c } = show({ text: "a" });
  unmount(c);
  await new Promise((r) => setTimeout(r, 100));
  expect(destroy).not.toHaveBeenCalled();
  destroy.mockRestore();
  expect(target.querySelector(".cm-editor")).toBeNull();
  expect(document.querySelector(".cm-editor")).toBeNull();
});
```

  The two failure tests are in their own files, because `vi.mock` applies to a whole file.

```ts
// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";

// The editor chunk fails to load, as when the phone is offline. This is its own file because vi.mock applies to the whole file.
vi.mock("./editor", () => { throw new Error("offline"); });
import CodeView from "./CodeView.svelte";

test("when the editor cannot load, the text shows in a pre box", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: { text: "<b>a</b>\nsecond", language: "typescript" } });
  await vi.waitFor(() => expect(target.querySelector("pre")).not.toBeNull());
  expect(target.querySelector("pre")!.textContent).toBe("<b>a</b>\nsecond");
  expect(target.querySelector("b")).toBeNull();
  expect(target.querySelector(".cm-editor")).toBeNull();
  unmount(c);
  target.remove();
});
```

```ts
// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";

// Only the language chunk fails to load. The editor must still show the text, without colors.
vi.mock("./languages", () => ({ loadLanguage: () => Promise.reject(new Error("offline")) }));
import CodeView from "./CodeView.svelte";

test("when the language cannot load, the editor shows the text without colors", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: { text: "const a = 1;", language: "typescript" } });
  await vi.waitFor(() => expect(target.querySelector(".cm-line")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(target.querySelector(".cm-line")!.textContent).toBe("const a = 1;");
  expect(target.querySelectorAll(".cm-line span").length).toBe(0);
  expect(target.querySelector("pre")).toBeNull();
  unmount(c);
  target.remove();
});
```

  What jsdom cannot test, and where it is tested instead (Task E): the height of the editor and how it grows, wrapping on screen and the horizontal scroll box, touch scrolling and selection, the painted colors, the contrast, a theme switch, the real chunk loading and a blocked chunk.
- [ ] **Step 3: See them fail.** Run `cd web && bun --bun vitest run src/lib/features/sessions/CodeView`. They fail because `./CodeView.svelte` does not exist.
- [ ] **Step 4: Write `codetheme.ts`.** Use this text. The `tags` list maps keywords, strings, numbers and names, comments, types and function names, markup names, markdown headings and links to the six colors.

```ts
// The look of CodeView: a CodeMirror theme and a highlight style that use only the CSS variables of the app theme
// (app.css and routes/layout.css). A variable is read when the browser paints, so a switch between light, dark, Ayu and
// Tokyo Night needs no rebuild of the editor. Only editor.ts imports this file, and editor.ts is loaded by import().
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// `--warn` is only 4.2 against the light card color, so numbers mix it with the text color. All six pass 4.5 in four palettes.
const PALETTE = {
  "--tok-keyword": "var(--primary)",
  "--tok-string": "var(--ok)",
  "--tok-number": "color-mix(in srgb, var(--warn) 80%, var(--foreground))",
  "--tok-comment": "var(--muted-foreground)",
  "--tok-title": "color-mix(in srgb, var(--primary) 70%, var(--foreground))",
  "--tok-meta": "var(--destructive)",
};

export const codeTheme: Extension = EditorView.theme({
  "&": { ...PALETTE, backgroundColor: "transparent", color: "var(--foreground)", fontSize: "0.875rem", maxWidth: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, monospace", lineHeight: "1.45" },
  ".cm-content": { padding: "0.75rem" },
  ".cm-line": { padding: "0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none" },
});

export const codeHighlight: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.null, t.bool, t.atom, t.unit], color: "var(--tok-keyword)" },
    { tag: [t.string, t.regexp, t.special(t.string), t.character, t.escape, t.inserted, t.monospace], color: "var(--tok-string)" },
    { tag: [t.number, t.integer, t.float, t.attributeName, t.propertyName, t.variableName], color: "var(--tok-number)" },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote], color: "var(--tok-comment)", fontStyle: "italic" },
    { tag: [t.typeName, t.className, t.namespace, t.labelName, t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--tok-title)" },
    { tag: [t.tagName, t.meta, t.processingInstruction, t.deleted, t.invalid, t.angleBracket], color: "var(--tok-meta)" },
    { tag: [t.heading, t.strong], color: "var(--tok-title)", fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: [t.link, t.url], color: "var(--primary)", textDecoration: "underline" },
  ]),
);
```

- [ ] **Step 5: Write `editor.ts`.** Use this text. It is the only file with `new EditorView`.

```ts
// The read-only CodeMirror editor behind CodeView.svelte. It imports CodeMirror, so only CodeView.svelte loads it, and
// only by import(). The editor builds only the lines in view, so a 512 KB file or one very long line opens at once.
// It writes text nodes, never HTML, so text from a file cannot become markup.
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { codeHighlight, codeTheme } from "./codetheme";

export type EditorOptions = { text: string; language?: Extension; wrap: boolean; lineNumbers: boolean };
export type Editor = {
  /** The document changes only when the text differs. This also resets the selection and the scroll position. */
  setText(text: string): void;
  /** `undefined` shows plain text with no colors. */
  setLanguage(language: Extension | undefined): void;
  setWrap(wrap: boolean): void;
  setLineNumbers(on: boolean): void;
  /** Removes the editor from the page and frees its listeners. Call it once, when the component goes away. */
  destroy(): void;
};

export function createEditor(parent: HTMLElement, initial: EditorOptions): Editor {
  const opts = { ...initial };
  const wrapC = new Compartment();
  const langC = new Compartment();
  const numbersC = new Compartment();
  const wrapExt = () => (opts.wrap ? EditorView.lineWrapping : []);
  const numbersExt = () => (opts.lineNumbers ? lineNumbers() : []);
  const build = () =>
    EditorState.create({
      doc: opts.text,
      extensions: [
        EditorState.readOnly.of(true), // the commands refuse to change the text
        EditorView.editable.of(false), // no caret, no keyboard on a phone, no editing actions in the menu
        EditorView.contentAttributes.of({ "aria-readonly": "true", "aria-label": "File content" }),
        codeTheme,
        codeHighlight,
        wrapC.of(wrapExt()),
        numbersC.of(numbersExt()),
        langC.of(opts.language ?? []),
      ],
    });
  const view = new EditorView({ parent, state: build() });
  return {
    setText(text) {
      if (text === opts.text) return;
      opts.text = text;
      view.setState(build());
    },
    setLanguage(language) {
      opts.language = language;
      view.dispatch({ effects: langC.reconfigure(language ?? []) });
    },
    setWrap(wrap) {
      opts.wrap = wrap;
      view.dispatch({ effects: wrapC.reconfigure(wrapExt()) });
    },
    setLineNumbers(on) {
      opts.lineNumbers = on;
      view.dispatch({ effects: numbersC.reconfigure(numbersExt()) });
    },
    destroy: () => view.destroy(),
  };
}
```

- [ ] **Step 6: Write `CodeView.svelte`.** Use this text. The `import("./editor")` call is the only way the component reaches CodeMirror. If it rejects, `failed` is set and the text shows in a `<pre>`.

```svelte
<script lang="ts">
  // A read-only code viewer. CodeMirror builds only the lines in view, so a file of 512 KB opens at once. This file imports
  // CodeMirror only by import(), so the library stays out of every page that shows no code. If the editor cannot load
  // (for example the phone is offline), the text shows in a plain pre box. If only the language cannot load, the editor
  // shows without colors.
  import { onMount } from "svelte";
  import type { Editor } from "./editor";
  import { loadLanguage } from "./languages";
  import type { LanguageId } from "./viewkind";

  type Props = { text: string; language?: LanguageId; wrap?: boolean; lineNumbers?: boolean };
  let { text, language, wrap = true, lineNumbers = false }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let editor: Editor | undefined = $state.raw();
  let failed = $state(false);

  onMount(() => {
    let gone = false;
    let made: Editor | undefined;
    import("./editor").then(
      ({ createEditor }) => {
        if (gone || !host) return;
        made = createEditor(host, { text, wrap, lineNumbers });
        editor = made;
      },
      () => {
        if (!gone) failed = true;
      },
    );
    return () => {
      gone = true;
      editor = undefined;
      made?.destroy();
    };
  });

  $effect(() => {
    const e = editor;
    if (!e) return;
    e.setText(text);
    e.setWrap(wrap);
    e.setLineNumbers(lineNumbers);
  });

  // The language loads on its own, so a slow or failed language never holds back the text.
  $effect(() => {
    const e = editor;
    const id = language;
    if (!e) return;
    let stale = false;
    (id ? loadLanguage(id) : Promise.resolve(undefined)).then(
      (ext) => { if (!stale) e.setLanguage(ext); },
      () => { if (!stale) e.setLanguage(undefined); },
    );
    return () => { stale = true; };
  });
</script>

{#if failed}
  <pre class="m-0 overflow-auto rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
{:else}
  <div bind:this={host} class="code-view min-w-0 max-w-full rounded-lg border bg-card"></div>
{/if}
```

- [ ] **Step 7: See the tests pass.** Run the command of Step 3. All 12 tests pass.
- [ ] **Step 8: Prove the tests bite.** Comment out `made?.destroy();` in `CodeView.svelte` and run `cd web && bun --bun vitest run src/lib/features/sessions/CodeView.test.ts`. The `destroy` test must fail. Restore the line. Do not commit the change.
- [ ] **Step 9: Run the checks.** `bun run --cwd web check` has 0 errors. `cd web && bun --bun vitest run src` is green (1109 in the scratch copy after Task C, before Task D).
- [ ] **Step 10: Commit.**

```bash
git add web/src/lib/features/sessions/codetheme.ts web/src/lib/features/sessions/editor.ts web/src/lib/features/sessions/CodeView.svelte web/src/lib/features/sessions/CodeView.test.ts web/src/lib/features/sessions/CodeViewfail.test.ts web/src/lib/features/sessions/CodeViewlang.test.ts web/src/lib/features/sessions/reactiveprops.svelte.ts
git commit -m "feat(web): add CodeView, a read-only CodeMirror viewer that loads lazily"
```

## Task D: The FilePreview integration

**Files:**
- Create: `FormattedText.svelte`, `FormattedText.test.ts`, `formatted.css` (in `web/src/lib/features/sessions`), `web/src/lib/rawhtml.test.ts`
- Modify: `web/src/lib/features/sessions/FilePreview.svelte`

**Interfaces:** `FormattedText` props, and the marks in the Interfaces section.

The preview shows:

1. A markdown file up to 100 K characters: `Rendered` (the sanitized HTML in `FormattedText`) and `Source` (CodeView with the markdown language). It opens rendered. While the worker runs, the page shows `Rendering...`. If the render fails or times out, the failed note and the plain view show.
2. A file with a known language: CodeView with colors.
3. Any other text: a `<pre>` up to 64 K characters, CodeView with no language above that. A markdown file above 100 K characters is also this case, with the too-large note.
4. A file that is not text: as today.

The Wrap switch (on by default) shows with every CodeView. The Download button and the truncation note do not change. The `data-preview` marks are on the outer element of each view. The switch rows use `size="touch"` (44 px).

`FilePreview.svelte` has no unit test, as before: it needs a query client and a network stub, and Task E covers it. The parts with logic (`viewKind`, `showsInPre`, `formatText`, `CodeView`) have tests.

- [ ] **Step 1: Write the raw HTML test and the component test first.**

`web/src/lib/rawhtml.test.ts`:

```ts
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The app inserts raw HTML in exactly one place: features/sessions/FormattedText.svelte, which takes only SafeHtml.
// CodeView.svelte does not need it: CodeMirror writes text nodes.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["lib/features/sessions/FormattedText.svelte"];
const SINKS = [/\{@html\b/g, /\.innerHTML\s*=/g, /\.outerHTML\s*=/g, /insertAdjacentHTML\s*\(/g, /document\.write\s*\(/g, /\bsrcdoc\b/g];

function sources(): string[] {
  const out: string[] = [];
  for (const ext of ["ts", "svelte", "js", "html"]) for (const f of new Bun.Glob(`**/*.${ext}`).scanSync({ cwd: SRC })) if (!f.endsWith(".test.ts")) out.push(f);
  return out.sort();
}

test("raw HTML is inserted only in FormattedText.svelte, exactly once", () => {
  const hits: Record<string, number> = {};
  for (const f of sources()) {
    const text = readFileSync(join(SRC, f), "utf8");
    const n = SINKS.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
    if (n > 0) hits[f] = n;
  }
  expect(hits).toEqual({ [ALLOWED[0]!]: 1 });
});
```

`FormattedText.test.ts`:

```ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { expect, test } from "vitest";
import FormattedText from "./FormattedText.svelte";
import { renderMarkdown } from "./markdown";

function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(FormattedText, { target, props: props as never });
  flushSync();
  return { target, done: () => { unmount(c); target.remove(); } };
}

test("hostile markdown, shown through the component, adds no script, image, frame or handler to the live page", () => {
  const src = "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1))\n\n<iframe src=x></iframe>\n\n# ok [b](https://ok.example)";
  const { target, done } = show({ html: renderMarkdown(src) });
  expect(target.querySelectorAll("script, img, iframe, svg, style, form, input").length).toBe(0);
  expect(Array.from(target.querySelectorAll("*")).some((e) => Array.from(e.attributes).some((a) => a.name.startsWith("on")))).toBe(false);
  expect(Array.from(target.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://ok.example"]);
  expect(target.textContent).toContain("<script>alert(1)</script>");
  done();
});

test("the rendered box has the formatted-md class", () => {
  const { target, done } = show({ html: renderMarkdown("# t") });
  expect(target.querySelector("div.formatted-md h1")?.textContent).toBe("t");
  done();
});
```

- [ ] **Step 2: See them fail.** Run `cd web && bun --bun vitest run src/lib/rawhtml.test.ts src/lib/features/sessions/FormattedText.test.ts`. They fail, because no file has the insert yet and the component does not exist.
- [ ] **Step 3: Write `FormattedText.svelte`.** The comment must not contain the raw insert text.

```svelte
<script lang="ts">
  // The only place in the app that inserts raw HTML. `html` has the type SafeHtml, which only sanitizeMarkdownHtml in
  // sanitize.ts can make. rawhtml.test.ts fails if any other file inserts raw HTML, or if this file does it twice. Code
  // never comes here: CodeView.svelte writes text nodes.
  import type { SafeHtml } from "./sanitize";
  import "./formatted.css";

  type Props = { html: SafeHtml };
  let { html }: Props = $props();
</script>

<div class="formatted-md">{@html html}</div>
```

- [ ] **Step 4: Write `formatted.css`.** Markdown typography only, theme variables only. The table rules matter: `display: block` with `overflow-x: auto` puts a wide table in its own scroll box, and `overflow-wrap: normal` on cells keeps words whole.

```css
/* Typography for rendered markdown. Only theme variables are used (app.css and routes/layout.css), so light, dark, Ayu and
   Tokyo Night all work. The colors of code come from codetheme.ts, not from here. */
.formatted-md { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; }
.formatted-md > :first-child { margin-top: 0; }
.formatted-md > :last-child { margin-bottom: 0; }
.formatted-md pre { overflow: auto; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--card); padding: 0.75rem; font: 0.875rem/1.45 ui-monospace, monospace; }
.formatted-md code { font-family: ui-monospace, monospace; font-size: 0.9em; }
.formatted-md :not(pre) > code { border-radius: 0.25rem; background: var(--muted); padding: 0.1em 0.3em; }
.formatted-md a { color: var(--primary); text-decoration: underline; }
.formatted-md blockquote { margin-inline: 0; border-inline-start: 3px solid var(--border); padding-inline-start: 1rem; color: var(--muted-foreground); }
.formatted-md table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.formatted-md th, .formatted-md td { overflow-wrap: normal; border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: start; }
.formatted-md th { background: var(--muted); }
.formatted-md hr { border: 0; border-top: 1px solid var(--border); }
```

- [ ] **Step 5: Replace `FilePreview.svelte`.** Use this text. What changed from the old file: the imports, the two `$state` values (`rendered`, `wrap`), two snippets (`wrapSwitch`, `plain`), and the new block for text files.

```svelte
<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Button } from "#lib/components/ui/button/index.js";
  import { downloadUrl } from "./api";
  import CodeView from "./CodeView.svelte";
  import { baseName, humanSize } from "./format";
  import { formatText } from "./formatted";
  import FormattedText from "./FormattedText.svelte";
  import { previewQuery } from "./queries";
  import { showsInPre, viewKind } from "./viewkind";

  // `abs`: `file` is the absolute path of a touched file outside the session folder.
  type Props = { host: string; instance: string; session: string; file: string; abs?: boolean; back: string };
  let { host, instance, session, file, abs = false, back }: Props = $props();

  const q = createQuery(() => previewQuery(host, instance, session, file, abs));
  const name = $derived(baseName(file));
  // Markdown opens rendered. Code and large plain text open wrapped, as the plain view always did.
  let rendered = $state(true);
  let wrap = $state(true);
</script>

<!-- The Wrap switch. It shows with every CodeView. -->
{#snippet wrapSwitch()}
  <Button size="touch" variant={wrap ? "default" : "outline"} aria-pressed={wrap} onclick={() => (wrap = !wrap)}>Wrap</Button>
{/snippet}

<!-- Plain text. A small text is a pre box. A larger text is a CodeView with no language, so a 512 KB file does not make a giant page. -->
{#snippet plain(text: string)}
  {#if showsInPre(text.length)}
    <pre data-preview="plain" class="m-0 overflow-auto rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
  {:else}
    {@render wrapSwitch()}
    <div data-preview="plain" class="min-w-0"><CodeView {text} {wrap} /></div>
  {/if}
{/snippet}

<div class="grid gap-3">
  <Button variant="outline" size="touch" href={back}>Back</Button>
  {#if q.isPending}
    <p class="text-muted-foreground">Loading file...</p>
  {:else if q.error}
    <p class="error">{q.error.message}</p>
  {:else if q.data}
    {@const p = q.data}
    <div class="grid gap-1">
      <div class="font-semibold [overflow-wrap:anywhere]">{p.name}</div>
      {#if abs}
        <div class="text-sm text-muted-foreground [overflow-wrap:anywhere]">{file}</div>
        <div class="text-sm text-muted-foreground">outside the session folder</div>
      {/if}
      <div class="text-muted-foreground">{humanSize(p.size)}</div>
    </div>
    {#if p.kind === "text"}
      {#if p.truncated}
        <p class="text-sm text-warning">Showing only the start of {humanSize(p.size)}. Download the file for the rest.</p>
      {/if}
      {@const text = p.text ?? ""}
      {@const plan = viewKind(p.name, text.length)}
      {#if plan.kind === "markdown"}
        {#await formatText(p.name, text)}
          <p class="text-muted-foreground">Rendering...</p>
        {:then f}
          {#if f.kind === "markdown"}
            <div class="flex gap-2" role="group" aria-label="Markdown view">
              <Button class="flex-1" size="touch" variant={rendered ? "default" : "outline"} aria-pressed={rendered} onclick={() => (rendered = true)}>Rendered</Button>
              <Button class="flex-1" size="touch" variant={rendered ? "outline" : "default"} aria-pressed={!rendered} onclick={() => (rendered = false)}>Source</Button>
            </div>
            {#if rendered}
              <div data-preview="rendered" class="min-w-0 rounded-lg border bg-card p-3"><FormattedText html={f.html} /></div>
            {:else}
              {@render wrapSwitch()}
              <div data-preview="source" class="min-w-0"><CodeView {text} language="markdown" {wrap} /></div>
            {/if}
          {:else}
            {#if f.note}<p class="text-sm text-muted-foreground">{f.note}</p>{/if}
            {@render plain(text)}
          {/if}
        {/await}
      {:else if plan.kind === "code"}
        {@render wrapSwitch()}
        <div data-preview="code" class="min-w-0"><CodeView {text} language={plan.language} {wrap} /></div>
      {:else}
        {#if plan.note}<p class="text-sm text-muted-foreground">{plan.note}</p>{/if}
        {@render plain(text)}
      {/if}
    {:else}
      <p class="text-muted-foreground" data-preview="binary">This file is not text, so it has no preview.</p>
    {/if}
    <Button size="touch" href={downloadUrl(host, instance, session, file, { abs })} download={name}>Download</Button>
  {/if}
</div>
```

- [ ] **Step 6: See the tests pass and prove the guard.** Run `cd web && bun --bun vitest run src/lib/rawhtml.test.ts src/lib/features/sessions/FormattedText.test.ts`. All pass. Then add the comment `<!-- {@html "x"} -->` to the end of `CodeView.svelte`, run `rawhtml.test.ts` and see it fail. Remove the line.
- [ ] **Step 7: Run all checks and read the build.**

```bash
export PATH=$HOME/.bun/bin:$PATH
bun run typecheck
bun run --cwd web check
(cd web && bun --bun vitest run src 2>&1 | tail -8)
bun run --cwd web build 2>&1 | tail -5
```

  All pass. `web/src/lib/boundaries.test.ts` is part of the run and stays green. The scratch copy reports `Tests 1112`. Then run the two bundle reports (the scripts are in Task E, Step 2, and Task B asks you to have them in `/tmp/fpcheck`):

```bash
cd web && bun /tmp/fpcheck/initcheck.ts $PWD && bun /tmp/fpcheck/chunks.ts $PWD
```

  `initcheck.ts` must print `no CodeMirror, marked or DOMPurify code in the initial load`. In the scratch copy the entry closure went from 463,271 bytes (main) to 474,626 bytes. This is the code of the sessions route (`CodeView`, `languages.ts`, `FilePreview`), which loads with that route. No library code is in it. `chunks.ts` lists the lazy language chunks. Measured sizes (raw bytes, gzip bytes) in the scratch copy:

| Chunk | Raw | Gzip |
| --- | --- | --- |
| CodeMirror core (view, state, language, lezer, the theme strings) | 284,119 | 91,366 |
| `editor.ts` | 2,381 | 1,077 |
| lang-javascript, css and lezer javascript (shared by ts, js, html, markdown) | 84,452 | 32,301 |
| lang-rust | 83,673 | 29,336 |
| lang-markdown | 44,759 | 15,325 |
| lang-python | 44,558 | 18,524 |
| lang-go | 30,703 | 12,258 |
| lang-html | 28,351 | 11,238 |
| lang-sql | 13,719 | 5,928 |
| lang-yaml | 11,538 | 5,169 |
| legacy dockerfile, shell, toml, diff, lang-json | 4,120 / 2,434 / 1,045 / 302 / 1,981 | 1,644 / 1,201 / 531 / 234 / 1,261 |
| markdown worker (marked) | 50,714 | 15,230 |
| DOMPurify | 29,938 | 11,719 |

  Hashes in the file names differ in your build. If CodeMirror core lands in the initial closure, a static import is wrong. Find it and fix it before you go on.
- [ ] **Step 8: Commit.**

```bash
git add web/src/lib/features/sessions/FormattedText.svelte web/src/lib/features/sessions/FormattedText.test.ts web/src/lib/features/sessions/formatted.css web/src/lib/features/sessions/FilePreview.svelte web/src/lib/rawhtml.test.ts
git commit -m "feat(web): show rendered markdown and CodeMirror code in the file preview"
```

## Task E: A real browser check

This task changes no file in the repo. It builds the web app, starts the real hub app with a fake sign-in and a fake instance, and drives it with Playwright at 390 by 844, in light and dark. The hub app is `createApp` from `server/src/app.ts` with a fake `UserAuthStrategy` and `staticHandler` from `server/src/static.ts`, which serves `web/dist`. The demo files are real files in a temporary folder that the real session code serves. `require("playwright")` works in a Bun script and `chromium.launch()` needs no options. The scripts are throwaways in `/tmp/fpcheck`.

What the script checks:

- **Part 1 (light and dark):** `report.md` renders (headings, lists, a wide table that scrolls in its own box), with a hostile `<script>`, a `javascript:` link, an entity encoded one, a remote image and an `<img onerror>`: no dialog, no console error, no unsafe node, two links left, every link has `rel` and `target`, the script tag shows as text. The Source switch shows CodeView with colors and the last line appears when scrolled to. `app.ts` has more than 10 colored spans in at least 5 distinct classes and at least 4 computed colors. Wrap off gives a horizontal scroll box and a shorter editor. `hostile.html` and `hostile.ts` show as text. `big.md` (300 KB) shows the too-large note. A 200 KB plain text uses CodeView. `notes.txt` is a `<pre>`. A binary file shows the old text. `mid.md` renders and `slow.md` (`"*a_".repeat(34133)`) falls back to plain with the failed note, within a few seconds at 4x, and the page stays responsive.
- **Part 2:** `big.ts` (512 KB), `aaa.ts` (131072 times `a`), `dashes.ini` (`--` times 65536), `braces.json` (512 KB of `{`), `quotes.py` (512 KB of `"`) and `min.ts` (one minified line of 512 KB) at 1x and 4x CPU slowdown: each opens in under 1.5 seconds with at most 100 DOM lines and no sideways page scroll, and the Wrap switch works.
- **Part 3 (phone, real touch events):** a swipe inside the code scrolls the page. With Wrap off, a sideways swipe moves only the code box and a vertical swipe still moves the page. Scrolling to the end of `big.ts` builds the last line and reaches the Download button. A double click selects a word and a line can be selected. (`Input.synthesizeScrollGesture` does nothing in headless Chromium here, so the script uses `Input.dispatchTouchEvent`.)
- **Part 4:** contrast of the six colors against the code box in light, dark, Ayu and Tokyo Night (at least 4.5), and a theme switch that changes a keyword color on the same editor element.
- **Part 5:** the sessions list page loads no CodeMirror, marked or DOMPurify code and no worker. Opening markdown loads `format.worker` with a JavaScript content type from the real static handler, plus marked and DOMPurify, and no CodeMirror. Opening a code file loads CodeMirror and no marked. With the editor chunk blocked, a code file shows in a `<pre>` and the Download button is still there.

- [ ] **Step 1: Build.** Run `export PATH=$HOME/.bun/bin:$PATH && bun run --cwd web build 2>&1 | tail -3`. It ends with `done`.
- [ ] **Step 2: Write the scripts.** Run `mkdir -p /tmp/fpcheck`. Save these three texts. `check.ts` is the browser check. `initcheck.ts` and `chunks.ts` read the Vite manifest of a web folder.

`/tmp/fpcheck/check.ts`:

````ts
// Throwaway check of the formatted preview in a real browser. Not part of the repo.
// Run from the repo root after `bun run --cwd web build`:   REPO=$PWD bun /tmp/fpcheck/check.ts
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.REPO ?? process.cwd();
const WEB_DIST = process.env.WEB_DIST ?? `${REPO}/web/dist`;
const SHOTS = process.env.SHOTS ?? "/tmp/fpcheck/shots";
const { createApp } = await import(`${REPO}/server/src/app`);
const { loadWebFilesFromDisk } = await import(`${REPO}/server/src/webfiles`);
const { staticHandler } = await import(`${REPO}/server/src/static`);
const { encodeProjectDir } = await import(`${REPO}/server/src/transcript`);
const { chromium } = require("playwright");

// ---- Demo folder, transcript and hub -------------------------------------------------------------------------------
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "fpcheck-")));
const proj = join(tmp, "proj");
const home = join(tmp, "home");
mkdirSync(proj);
const ID = "0123456789ab";
const SID = "11111111-1111-4111-8111-111111111111";
const projects = join(home, ".claude", "projects", encodeProjectDir(proj));
mkdirSync(projects, { recursive: true });
writeFileSync(join(projects, `${SID}.jsonl`), JSON.stringify({ type: "user", cwd: proj, timestamp: "2026-11-12T10:00:00Z", sessionId: SID }) + "\n");

const KB = 1024;
const put = (name: string, text: string | Buffer) => writeFileSync(join(proj, name), text);
const wide = (n: number) => `| ${Array.from({ length: n }, (_, i) => `column number ${i}`).join(" | ")} |\n|${" --- |".repeat(n)}\n| ${Array.from({ length: n }, (_, i) => `a long cell value ${i}`).join(" | ")} |\n`;
put("report.md", [
  "# Report", "", "Intro with **bold**, *italic*, `code` and a [safe link](https://example.com/page?a=1&b=2).", "",
  "## List", "", "- one", "- two", "  - nested", "", "1. first", "2. second", "", "- [x] done", "- [ ] todo", "",
  "> A quote", "", "## Table", "", wide(8), "## Code", "", "```ts", "const a: number = 1;", "```", "",
  "## Hostile", "", "<script>alert(1)</script>", "", "[bad link](javascript:alert(1))", "", "[bad entity](java&#115;cript:alert(2))", "",
  "![tracker](https://example.com/pixel.png)", "", "<img src=x onerror=alert(3)>", "",
].join("\n"));
const TS_LINE = "export function greet(name: string, n: number = 42): string { return `hello ${name}` + n; } // a comment\n";
put("app.ts", `import { x } from "./x";\n\nexport class Greeter<T> {\n  private readonly items: Map<string, T> = new Map();\n  // a comment\n  greet(name: string): string {\n    const n: number = 42;\n    if (name === "") return "none";\n    return "hello " + name + n; // ${"x".repeat(300)}\n  }\n}\n\n${TS_LINE}`);
put("big.ts", TS_LINE.repeat(Math.ceil((512 * KB) / TS_LINE.length)).slice(0, 512 * KB));
put("aaa.ts", "a".repeat(131072));
put("dashes.ini", "--".repeat(65536));
put("braces.json", "{".repeat(512 * KB));
put("quotes.py", '"'.repeat(512 * KB));
put("min.ts", "var a=function(b){return b+1};".repeat(Math.ceil((512 * KB) / 29)).slice(0, 512 * KB));
put("hostile.html", "<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n<a href=\"javascript:alert(3)\">x</a>\n<style>*{display:none}</style>\n");
put("hostile.ts", 'const a = "<script>alert(1)</script><img src=x onerror=alert(2)>";\n');
put("big.md", "# big\n\n" + "A line of text in a big file.\n".repeat(Math.ceil((300 * KB) / 30)));
put("slow.md", "*a_".repeat(34133)); // 102,399 characters: under the 100 K limit, and it freezes marked
put("mid.md", "# mid\n\n" + "| a | b |\n|---|---|\n| 1 | [x](https://example.com) |\n\n- [ ] item **bold** `c`\n\n".repeat(1100));
put("plainbig.txt", "plain text line number x of a big file that is not code\n".repeat(Math.ceil((200 * KB) / 56)));
put("notes.txt", "plain notes\n");
put("blob.bin", Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 9, 8, 7]));

const instance = { id: ID, path: proj, name: "demo", state: "active", startedAt: null };
const fakeInstances: any = {
  list: async () => [instance], start: async () => instance, stop: async () => {}, logs: async () => "", users: async () => ({ selectable: false, default: "svc", users: [{ name: "svc" }] }),
  trustFilter: async () => () => false, dirOwnerFor: async () => undefined, claudeHome: async () => ({ path: proj, home }),
};
const userAuth = { middleware: async (c: any, next: any) => { c.set("user", { sub: "u1", name: "Ann" }); await next(); } };
const cfg: any = { mode: "hub", publicUrl: "http://127.0.0.1", roots: [tmp], hosts: [], userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" } } };
const files = await loadWebFilesFromDisk(WEB_DIST);
if (!files.has("/index.html")) throw new Error(`no build in ${WEB_DIST}: run bun run --cwd web build`);
const app = createApp({ cfg, instances: fakeInstances, userAuth, staticHandler: staticHandler(files) });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;

// ---- Helpers ---------------------------------------------------------------------------------------------------------
const failures: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
mkdirSync(SHOTS, { recursive: true });
const url = (file: string, extra = "") => `${base}/sessions?host=local&instance=${ID}&session=${SID}&view=folder&file=${encodeURIComponent(file)}${extra}`;
const browser = await chromium.launch();
// The fake hub has no release, update or event feed. It answers 501 on these three addresses, and nothing else may fail.
const NO_FEED = new Set(["/api/latest", "/api/updates", "/api/events"]);

type Watch = { dialogs: string[]; errors: string[] };
function watch(page: any): Watch {
  const w: Watch = { dialogs: [], errors: [] };
  page.on("dialog", (d: any) => { w.dialogs.push(d.message()); d.dismiss(); });
  page.on("response", (r: any) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && !(r.status() === 501 && NO_FEED.has(p))) w.errors.push(`${r.status()} ${p}`); });
  page.on("console", (m: any) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) w.errors.push(m.text()); });
  page.on("pageerror", (e: any) => w.errors.push(String(e)));
  return w;
}
const noSideScroll = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const domLines = (page: any) => page.evaluate(() => document.querySelectorAll(".cm-line").length);

// ---- Part 1: markdown, code, plain and binary, light and dark ----------------------------------------------------------
for (const scheme of ["light", "dark"] as const) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  const w = watch(page);
  const tag = (s: string) => `[${scheme}] ${s}`;
  const shot = (n: string) => page.screenshot({ path: `${SHOTS}/${scheme}-${n}.png`, fullPage: true });
  const open = async (file: string, mode: string) => { await page.goto(url(file)); await page.waitForSelector(`[data-preview="${mode}"]`, { timeout: 15000 }); };
  const side = async (s: string) => check(await noSideScroll(page), tag(`no horizontal page scroll: ${s}`));

  await open("report.md", "rendered");
  check((await page.evaluate(() => document.documentElement.classList.contains("dark"))) === (scheme === "dark"), tag("theme matches the color scheme"));
  const md = await page.evaluate(() => {
    const root = document.querySelector(".formatted-md")!;
    const links = [...root.querySelectorAll("a")];
    const table = root.querySelector("table")!;
    return {
      headings: root.querySelectorAll("h1,h2").length, lists: root.querySelectorAll("ul,ol").length,
      badNodes: root.querySelectorAll("script,img,iframe,svg,form,style,[onerror],[onclick]").length,
      badLinks: links.filter((a) => /^(javascript|data|vbscript):/i.test(a.getAttribute("href") ?? "")).length,
      linkCount: links.length,
      linksOk: links.every((a) => a.getAttribute("target") === "_blank" && a.getAttribute("rel") === "noopener noreferrer nofollow"),
      hasScriptText: root.textContent!.includes("<script>alert(1)</script>"),
      tableScrolls: table.scrollWidth > table.clientWidth, tableInside: table.getBoundingClientRect().right <= window.innerWidth,
    };
  });
  check(md.headings >= 3 && md.lists >= 2, tag("markdown has headings and lists"));
  check(md.badNodes === 0, tag("no script, img, iframe, svg, form, style or handler in the rendered markdown"));
  check(md.badLinks === 0, tag("no javascript:, data: or vbscript: link"));
  check(md.linkCount === 2, tag(`only the safe link and the image link remain as links (found ${md.linkCount})`));
  check(md.linksOk, tag("every link has target=_blank and rel=noopener noreferrer nofollow"));
  check(md.hasScriptText, tag("the script tag shows as text"));
  check(md.tableScrolls && md.tableInside, tag("the wide table scrolls inside its own box"));
  await side("report.md rendered");
  await shot("report-rendered");
  // The Source switch shows the markdown in CodeView.
  await page.getByRole("button", { name: "Source" }).click();
  await page.waitForSelector('[data-preview="source"] .cm-line');
  check((await page.textContent('[data-preview="source"]'))!.includes("# Report"), tag("Source shows the raw markdown in CodeView"));
  check(await page.evaluate(() => document.querySelectorAll('[data-preview="source"] .cm-line span').length > 3), tag("the markdown source has colors"));
  // Lines below the fold are built when they come into view, so a full page screenshot can show a gap. Scroll to the end to prove they appear.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  check((await page.evaluate(() => document.querySelector(".cm-content")!.textContent!.includes("const a: number = 1;"))), tag("scrolling to the end of the Source view builds the last line"));
  await page.evaluate(() => window.scrollTo(0, 0));
  await side("report.md source");
  await shot("report-source");
  await page.getByRole("button", { name: "Rendered" }).click();
  await page.waitForSelector('[data-preview="rendered"]');

  // TypeScript with colors, and the Wrap switch.
  await open("app.ts", "code");
  await page.waitForSelector('[data-preview="code"] .cm-line span');
  const cls = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-preview="code"] .cm-line span')];
    return { spans: spans.length, classes: new Set(spans.map((s) => s.className)).size, colors: new Set(spans.map((s) => getComputedStyle(s).color)).size };
  });
  check(cls.spans > 10 && cls.classes >= 5, tag(`app.ts has colored spans (${cls.spans}) in at least 5 distinct highlight classes (${cls.classes})`));
  check(cls.colors >= 4, tag(`app.ts uses at least 4 different colors (${cls.colors})`));
  await side("app.ts wrapped");
  await shot("code-wrapped");
  const wrapOn = await page.evaluate(() => document.querySelector(".cm-content")!.classList.contains("cm-lineWrapping"));
  const hOn = await page.evaluate(() => document.querySelector(".cm-editor")!.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Wrap" }).click();
  const off = await page.evaluate(() => { const s = document.querySelector<HTMLElement>(".cm-scroller")!; return { wrap: document.querySelector(".cm-content")!.classList.contains("cm-lineWrapping"), scrolls: s.scrollWidth > s.clientWidth, h: document.querySelector(".cm-editor")!.getBoundingClientRect().height }; });
  check(wrapOn && !off.wrap && off.scrolls && off.h < hOn, tag(`Wrap off: the long line scrolls inside its own box and the editor gets shorter (${Math.round(hOn)} to ${Math.round(off.h)} px)`));
  await side("app.ts not wrapped");
  await shot("code-nowrap");

  // Hostile text in code files is text.
  for (const f of ["hostile.html", "hostile.ts"]) {
    await open(f, "code");
    await page.waitForSelector(".cm-line");
    const r = await page.evaluate(() => ({ bad: document.querySelectorAll('[data-preview="code"] script, [data-preview="code"] img, [data-preview="code"] a, [data-preview="code"] iframe, [data-preview="code"] style').length, text: document.querySelector(".cm-content")!.textContent!.includes("<script>alert(1)</script>") }));
    check(r.bad === 0 && r.text, tag(`${f}: hostile text shows as text and creates no element`));
  }

  // Too large markdown, plain, large plain, binary.
  await open("big.md", "plain");
  check((await page.textContent("body"))!.includes("too many to format"), tag("big.md (300 KB) shows the too-large note"));
  check((await page.locator(".formatted-md").count()) === 0, tag("big.md is not rendered"));
  await page.waitForSelector(".cm-line");
  check((await domLines(page)) <= 100, tag(`big.md as plain text builds at most 100 lines (${await domLines(page)})`));
  await shot("too-large");
  await open("notes.txt", "plain");
  check((await page.locator("pre[data-preview=plain]").count()) === 1 && (await page.locator(".cm-editor").count()) === 0, tag("notes.txt is a pre box with no editor"));
  check((await page.locator("p:has-text('too many to format')").count()) === 0, tag("notes.txt shows no note"));
  await open("plainbig.txt", "plain");
  await page.waitForSelector(".cm-line");
  check((await page.locator("pre[data-preview=plain]").count()) === 0 && (await domLines(page)) <= 100, tag(`plainbig.txt (200 KB) uses CodeView with at most 100 lines (${await domLines(page)})`));
  await open("blob.bin", "binary");
  await shot("binary");

  // Markdown limits on a slowed CPU.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  let t0 = Date.now();
  await open("mid.md", "rendered");
  console.log(`info ${tag(`mid.md (about 80 KB) rendered in ${Date.now() - t0} ms with the CPU slowed 4 times`)}`);
  check(Date.now() - t0 < 10000, tag("mid.md renders in under 10 seconds on a slowed CPU"));
  t0 = Date.now();
  await page.goto(url("slow.md"));
  await page.waitForSelector(".cm-line, [data-preview=plain]", { timeout: 15000 });
  const slowMs = Date.now() - t0;
  console.log(`info ${tag(`slow.md fell back to plain text in ${slowMs} ms with the CPU slowed 4 times`)}`);
  check((await page.textContent("body"))!.includes("could not be formatted") && slowMs < 6000, tag("slow.md (the worker times out) falls back to plain text with a note"));
  check((await page.evaluate(() => new Promise((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0); }))) < 500, tag("the page is responsive after the timeout"));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  check(w.dialogs.length === 0, tag(`no dialog (${w.dialogs.join(" | ")})`));
  check(w.errors.length === 0, tag(`no console error (${w.errors.join(" | ")})`));
  await ctx.close();
}

// ---- Part 2: the inputs that froze highlight.js, at 1x and 4x CPU ------------------------------------------------------
for (const rate of [1, 4]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
  const page = await ctx.newPage();
  const w = watch(page);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  for (const f of ["big.ts", "aaa.ts", "dashes.ini", "braces.json", "quotes.py", "min.ts"]) {
    const t0 = Date.now();
    await page.goto(url(f));
    await page.waitForSelector('[data-preview="code"] .cm-line', { timeout: 20000 });
    const ms = Date.now() - t0;
    const lines = await domLines(page);
    const side = await noSideScroll(page);
    console.log(`info [${rate}x] ${f.padEnd(12)} ${String(ms).padStart(5)} ms, ${lines} DOM lines`);
    check(ms < 1500 && lines <= 100 && side, `[${rate}x] ${f} opens in under 1.5 s (${ms} ms) with at most 100 DOM lines (${lines}) and no sideways page scroll`);
    // The Wrap switch changes the layout, with a very long line too.
    const before = await page.evaluate(() => document.querySelector(".cm-editor")!.getBoundingClientRect().height);
    await page.getByRole("button", { name: "Wrap" }).click();
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => document.querySelector(".cm-editor")!.getBoundingClientRect().height);
    check(!(await page.evaluate(() => document.querySelector(".cm-content")!.classList.contains("cm-lineWrapping"))) && (await noSideScroll(page)), `[${rate}x] ${f}: Wrap off works and the page does not scroll sideways (editor ${Math.round(before)} to ${Math.round(after)} px)`);
  }
  check(w.dialogs.length === 0 && w.errors.length === 0, `[${rate}x] no dialog and no console error (${[...w.dialogs, ...w.errors].join(" | ")})`);
  await ctx.close();
}

// ---- Part 3: phone behavior: touch scroll, the end of a big file, selection -----------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const w = watch(page);
  await page.goto(url("big.ts"));
  await page.waitForSelector('[data-preview="code"] .cm-line');
  const cdp = await ctx.newCDPSession(page);
  // Input.synthesizeScrollGesture does nothing in headless Chromium here, so the swipe is real touch events.
  const swipe = async (x: number, y: number, dx: number, dy: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10 }] }); await page.waitForTimeout(16); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500);
  };
  // A swipe that starts inside the code must scroll the page: there is no nested vertical scroll box.
  const line = (await page.locator(".cm-line").first().boundingBox())!;
  const y0 = await page.evaluate(() => window.scrollY);
  await swipe(195, line.y + 20, 0, -400);
  const y1 = await page.evaluate(() => window.scrollY);
  check(y1 > y0 + 200, `a touch swipe that starts inside the code scrolls the page (${y0} to ${y1})`);
  // With Wrap off, a sideways swipe moves the code inside its box and never the page, and a vertical swipe still moves the page.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Wrap" }).click();
  await page.waitForTimeout(300);
  const l2 = (await page.locator(".cm-line").first().boundingBox())!;
  await swipe(300, l2.y + 20, -200, 0);
  const sx = await page.evaluate(() => ({ box: document.querySelector<HTMLElement>(".cm-scroller")!.scrollLeft, page: window.scrollX }));
  check(sx.box > 50 && sx.page === 0, `Wrap off: a sideways swipe scrolls the code box (${sx.box} px) and not the page (${sx.page} px)`);
  const y2 = await page.evaluate(() => window.scrollY);
  await swipe(195, l2.y + 20, 0, -400);
  check((await page.evaluate(() => window.scrollY)) > y2 + 200, "Wrap off: a vertical swipe inside the code still scrolls the page");
  await page.getByRole("button", { name: "Wrap" }).click();
  check(await page.evaluate(() => { const s = document.querySelector<HTMLElement>(".cm-scroller")!; const e = document.querySelector<HTMLElement>(".cm-editor")!; return getComputedStyle(s).overflowY !== "scroll" && e.scrollTop === 0 && s.scrollTop === 0; }), "the code box has no vertical scroll of its own");
  // Scroll to the end of the file: the last line is built, and the Download button is reachable.
  for (let i = 0; i < 40; i++) { await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(150); }
  const end = await page.evaluate(() => ({ last: [...document.querySelectorAll(".cm-line")].at(-1)?.textContent?.slice(0, 30) ?? "", dl: !!document.querySelector("a[download]"), lines: document.querySelectorAll(".cm-line").length }));
  const dlBox = await page.locator("a[download]").boundingBox();
  check(end.lines <= 120 && end.last.startsWith("export function greet") && dlBox !== null, `scrolling to the end of big.ts builds the last line and reaches the Download button (${end.lines} lines in the DOM)`);
  await page.screenshot({ path: `${SHOTS}/phone-big-end.png` });
  // Selection: a long press or double click on a word selects it, and the text can be copied.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const box = await page.locator(".cm-line").first().boundingBox();
  await page.mouse.dblclick(box!.x + 40, box!.y + box!.height / 2);
  const sel = await page.evaluate(() => getSelection()!.toString());
  check(sel.length > 0 && sel.length < 40, `a double click selects a word in the code (selected "${sel}")`);
  await page.evaluate(() => { const l = document.querySelector(".cm-line")!; const r = document.createRange(); r.selectNodeContents(l); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
  check((await page.evaluate(() => getSelection()!.toString())).startsWith("export function greet"), "the text of a line can be selected for copy");
  check(w.errors.length === 0 && w.dialogs.length === 0, `no console error or dialog on the phone (${w.errors.join(" | ")})`);
  await ctx.close();
}

// ---- Part 4: contrast in four palettes -------------------------------------------------------------------------------------
{
  const contrastOf = (page: any) => page.evaluate(() => {
    const box = document.querySelector(".code-view")!;
    const rgb = (c: string) => { const x = document.createElement("canvas").getContext("2d")!; x.fillStyle = "#000"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3); };
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!); };
    const bg = rgb(getComputedStyle(box).backgroundColor);
    const host = document.querySelector(".cm-editor")!;
    const out: Record<string, number> = {};
    for (const name of ["keyword", "string", "number", "comment", "title", "meta"]) {
      const probe = document.createElement("span");
      probe.style.color = `var(--tok-${name})`;
      host.append(probe);
      const a = lum(rgb(getComputedStyle(probe).color)), b = lum(bg);
      probe.remove();
      out[name] = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10;
    }
    return out;
  });
  const palettes: [string, string, string][] = [["light", "light", ""], ["dark", "dark", ""], ["ayu", "dark", "&theme=ayu"], ["tokyonight", "dark", "&theme=tokyonight"]];
  for (const [label, scheme, extra] of palettes) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(url("app.ts", extra));
    await page.waitForSelector('[data-preview="code"] .cm-line span');
    const ratios = await contrastOf(page);
    console.log(`info [${label}] code color contrast: ${JSON.stringify(ratios)}`);
    check(Object.values(ratios).every((r) => r >= 4.5), `[${label}] every code color has a contrast of at least 4.5 against the code box`);
    await page.screenshot({ path: `${SHOTS}/palette-${label}-code.png` });
    await ctx.close();
  }
  // A theme switch needs no rebuild: the same editor changes color when the html class changes.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(url("app.ts"));
  await page.waitForSelector('[data-preview="code"] .cm-line span');
  const kw = () => page.evaluate(() => { const s = [...document.querySelectorAll(".cm-line span")].find((x) => x.textContent === "export")!; return getComputedStyle(s).color; });
  const before = await kw();
  await page.evaluate(() => { (document.querySelector(".cm-editor") as any).__same = true; document.documentElement.classList.add("dark"); });
  await page.waitForTimeout(100);
  const after = await kw();
  check(before !== after && (await page.evaluate(() => (document.querySelector(".cm-editor") as any).__same === true)), `a theme switch changes the code colors without rebuilding the editor (${before} to ${after})`);
  await ctx.close();
}

// ---- Part 5: lazy loading, the worker file, a failed import -----------------------------------------------------------------
{
  const MARKS = ["cm-scroller", "walkTokens", "ALLOWED_TAGS"];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const seen: { url: string; type: string; marks: string[] }[] = [];
  page.on("response", async (r: any) => {
    const u = new URL(r.url());
    if (!u.pathname.endsWith(".js")) return;
    const body = await r.text().catch(() => "");
    seen.push({ url: u.pathname, type: r.headers()["content-type"] ?? "", marks: MARKS.filter((m) => body.includes(m)) });
  });
  await page.goto(`${base}/sessions?host=local&instance=${ID}`);
  await page.waitForLoadState("networkidle");
  const listJs = seen.length;
  check(listJs > 0 && seen.every((s) => s.marks.length === 0 && !s.url.includes("worker")), `the sessions list loads ${listJs} script files, none with CodeMirror, marked or DOMPurify code, and no worker`);
  seen.length = 0;
  await page.goto(url("report.md"));
  await page.waitForSelector('[data-preview="rendered"]');
  const worker = seen.find((s) => s.url.includes("format.worker"));
  check(!!worker && /javascript/.test(worker.type), `opening markdown loads the worker file with a JavaScript content type (${worker?.url} ${worker?.type})`);
  check(seen.some((s) => s.marks.includes("walkTokens")) && seen.some((s) => s.marks.includes("ALLOWED_TAGS")), "opening markdown loads marked (in the worker) and DOMPurify");
  check(!seen.some((s) => s.marks.includes("cm-scroller")), "opening rendered markdown loads no CodeMirror");
  seen.length = 0;
  await page.goto(url("app.ts"));
  await page.waitForSelector('[data-preview="code"] .cm-line span');
  check(seen.some((s) => s.marks.includes("cm-scroller")), "opening a code file loads CodeMirror");
  check(!seen.some((s) => s.marks.includes("walkTokens")), "opening a code file loads no marked");
  await ctx.close();

  // A failed lazy import (offline): the editor chunk is blocked, so the text shows in a pre box and the page still works.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page2 = await ctx2.newPage();
  const w2 = watch(page2);
  await page2.route(/\/_app\/immutable\/(chunks|workers)\/.*\.js$/, async (route: any) => {
    const u = route.request().url();
    // Let every chunk through except the ones that hold the editor: find them by asking for the body first.
    const resp = await route.fetch();
    const body = await resp.text();
    if (body.includes("cm-scroller")) return route.abort();
    return route.fulfill({ response: resp, body });
  });
  await page2.goto(url("app.ts"));
  await page2.waitForSelector('pre', { timeout: 15000 });
  check((await page2.textContent("pre"))!.includes("export class Greeter") && (await page2.locator(".cm-editor").count()) === 0, "offline: when the editor chunk is blocked, a code file shows as plain text in a pre box");
  check((await page2.getByRole("button", { name: "Download" }).count()) + (await page2.locator("a[download]").count()) > 0, "offline: the Download button is still there");
  await ctx2.close();
}
await browser.close();
server.stop(true);
console.log(failures.length ? `\n${failures.length} FAILED:\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
````

`/tmp/fpcheck/initcheck.ts`:

```ts
// Usage: bun initcheck.ts <web dir>. Prints the initial entry closure and checks it for library markers.
import { readFileSync } from "node:fs";
const web = process.argv[2]!;
const out = `${web}/.svelte-kit/output/client`;
const m: Record<string, any> = JSON.parse(readFileSync(`${out}/.vite/manifest.json`, "utf8"));
const seen = new Set<string>();
const walk = (k: string) => { if (seen.has(k) || !m[k]) return; seen.add(k); (m[k].imports ?? []).forEach(walk); };
Object.keys(m).filter((k) => m[k].isEntry).forEach(walk);
let total = 0; const bad: string[] = [];
for (const k of seen) { const t = readFileSync(`${out}/${m[k].file}`, "utf8"); total += t.length; for (const mark of ["cm-scroller", "cm-content", "ALLOWED_TAGS", "walkTokens"]) if (t.includes(mark)) bad.push(`${m[k].file} has ${mark}`); }
console.log(`initial closure: ${seen.size} files, ${total} bytes`);
console.log(bad.length ? `LIBRARY CODE IN THE INITIAL LOAD:\n${bad.join("\n")}` : "no CodeMirror, marked or DOMPurify code in the initial load");
```

`/tmp/fpcheck/chunks.ts`:

```ts
// Usage: bun chunks.ts <web dir>. Lists the initial load and the lazy chunks from the Vite manifest.
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
const web = process.argv[2]!;
const out = `${web}/.svelte-kit/output/client`;
const m: Record<string, { file: string; src?: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean; isDynamicEntry?: boolean }> = JSON.parse(readFileSync(`${out}/.vite/manifest.json`, "utf8"));
const size = (file: string) => { const b = readFileSync(`${out}/${file}`); return [b.length, gzipSync(b).length] as const; };
const closure = (keys: string[]) => { const seen = new Set<string>(); const walk = (k: string) => { if (seen.has(k) || !m[k]) return; seen.add(k); for (const i of m[k]!.imports ?? []) walk(i); }; keys.forEach(walk); return seen; };
const entries = Object.keys(m).filter((k) => m[k]!.isEntry);
const initial = closure(entries);
let raw = 0, gz = 0;
for (const k of initial) { const [r, g] = size(m[k]!.file); raw += r; gz += g; }
console.log(`initial entry closure: ${initial.size} files, ${raw} bytes, ${gz} gzip`);
console.log("lazy chunks (dynamic entries), raw bytes / gzip bytes:");
for (const [k, v] of Object.entries(m)) if (v.isDynamicEntry && /codemirror|lezer|marked|dompurify|worker|editor|languages|codetheme|CodeView|Formatted|formatted/i.test(k + (v.src ?? ""))) { const [r, g] = size(v.file); console.log(`  ${String(r).padStart(7)} ${String(g).padStart(6)}  ${v.src ?? k}`); }
```

- [ ] **Step 3: Run it.** From the repo root:

```bash
export PATH=$HOME/.bun/bin:$PATH
REPO=$PWD timeout 600 bun /tmp/fpcheck/check.ts 2>&1 | tee /tmp/fpcheck/out.txt | grep -v "^ok"
```

  The last line must be `all checks passed`, and `grep -c "^ok" /tmp/fpcheck/out.txt` prints 109. The `info` lines in the scratch copy were (times vary by machine):

```
info [light] mid.md (about 80 KB) rendered in 1681 ms with the CPU slowed 4 times
info [light] slow.md fell back to plain text in 2967 ms with the CPU slowed 4 times
info [1x] big.ts          145 ms, 9 DOM lines
info [1x] aaa.ts          126 ms, 1 DOM lines
info [1x] dashes.ini      411 ms, 1 DOM lines
info [1x] braces.json     411 ms, 1 DOM lines
info [1x] quotes.py       383 ms, 1 DOM lines
info [1x] min.ts          195 ms, 1 DOM lines
info [4x] big.ts          549 ms, 9 DOM lines
info [4x] aaa.ts          476 ms, 1 DOM lines
info [4x] dashes.ini      432 ms, 1 DOM lines
info [4x] braces.json     843 ms, 1 DOM lines
info [4x] quotes.py       728 ms, 1 DOM lines
info [4x] min.ts          758 ms, 1 DOM lines
info [light] code color contrast: {"keyword":6,"string":5.1,"number":5.6,"comment":5.3,"title":8.5,"meta":5.6}
info [dark] code color contrast: {"keyword":5.2,"string":8.7,"number":10.4,"comment":6,"title":7.1,"meta":6}
info [ayu] code color contrast: {"keyword":9.3,"string":10.8,"number":9.9,"comment":5.8,"title":9.2,"meta":6.2}
info [tokyonight] code color contrast: {"keyword":6.2,"string":8.5,"number":8,"comment":6.4,"title":7.1,"meta":5.9}
```

  The times for the six large files include the page load, the 512 KB download, the editor chunk and the language chunk. They are measured from `goto` to the first built line. If a check fails, fix the code in the repo, rebuild and run again. Do not change a check to make it pass, unless the check itself is wrong, and then say so in your report.
- [ ] **Step 4: Look at the screenshots.** The script writes them to `/tmp/fpcheck/shots`. Open each with the Read tool: `light-report-rendered.png`, `dark-report-rendered.png`, `light-report-source.png`, `light-code-wrapped.png`, `dark-code-wrapped.png`, `dark-code-nowrap.png`, `light-too-large.png`, `dark-binary.png`, `phone-big-end.png` and the four `palette-*-code.png`. Look for text that is hard to read, a table that cuts off without a scroll box, a button that is too small to tap, a color that is hard to see, and a layout that breaks. In the scratch copy, the code in light and dark is readable, keywords, strings, numbers, types and comments have distinct colors, the Wrap button is full width and 44 px high, and the code box has the same border and radius as before. The full page screenshots of `report.md` Source and `big.md` show an empty band below the last built line. This is the unbuilt part of the page below the fold (see Review Focus). The bottom navigation bar shows in the middle of a full page screenshot because it is fixed. Write down what you saw in your report.
- [ ] **Step 5: Check that nothing leaked into the repo.** Run `git status --short`. Only the files that were untracked at the start (`.oidc/`, `.serena/`, `HANDOVER.md`, `run.sh`) may appear. There is no commit in this task.

## Task F: Documentation

**Files:**
- Modify: `README.md`, `docs/session-files.md`

- [ ] **Step 1: README.** In the "Session files" section, replace the bullet that starts with `- A text file shows as plain text.` (it has two lines) with this text:

```markdown
- A markdown file (`.md` or `.markdown`) shows rendered, with headings, lists, tables, code blocks, quotes, links and
  task lists. A switch at the top shows the plain text instead, with colors. A file in one of these languages shows
  with colors: TypeScript, JavaScript, JSON, Python, shell, YAML, HTML and XML (also Svelte and Vue), CSS, SQL, Go,
  Rust, INI and TOML, diff, Dockerfile and Makefile. A switch turns line wrapping on and off. Any other text file
  shows as plain text. A larger text file shows its first 512 KB and a download button. Any other file is a download.
- The preview renders markdown up to 100 K characters. K is 1,024, and the count is characters of the text, not
  bytes. A larger markdown file shows as plain text with a note. If rendering fails for any reason, the file shows as
  plain text with a note. Code has no size limit below the 512 KB cut. The code view builds only the lines on the
  screen, so a large file opens at once.
- A markdown file cannot run code or load anything from another site. The preview shows raw HTML in the file as text.
  It never loads an image: an image shows as a link with its alt text. It keeps only links that start with
  `http://`, `https://` or `mailto:`. Any other link, including a relative link, shows as plain text. A link that stays
  opens in a new tab. Code never goes through HTML: the code view writes plain text, so a code file cannot add
  an element to the page.
```

  Then replace the paragraph that starts with `The first version shows only the work trees` with: `The preview has no editor, no line numbers and no search. Session files are not yet verified on Windows nodes.` Keep the rest of the section.
- [ ] **Step 2: The code guide.** In `docs/session-files.md`, add these rows to the module map table, after the `format.ts (web)` row:

```markdown
| `viewkind.ts` (web) | Pure. Decides how a preview shows a text file: markdown, code or plain, and the language. It holds the file name map and the size rules. |
| `formatted.ts`, `formatrunner.ts`, `formatjobs.ts`, `format.worker.ts` (web) | Render markdown. The worker runs `marked` with a two second limit. `formatted.ts` sanitizes the result on the main thread and falls back to plain text when anything fails. |
| `markdown.ts`, `sanitize.ts` (web) | The markdown renderer used by the tests, and the sanitizer. Only the preview page loads them. |
| `FormattedText.svelte` (web) | The only place that inserts HTML into the page. It takes only text that went through the sanitizer. |
| `CodeView.svelte`, `editor.ts`, `codetheme.ts`, `languages.ts` (web) | The read-only code viewer. `CodeView.svelte` loads the editor and one language by `import()`. `editor.ts` builds the CodeMirror view. `codetheme.ts` maps the colors to the theme variables. `languages.ts` holds one lazy loader for each language. |
```

  Then add a new section at the end of the file, after "Cost and threading", with this text:

```markdown
## How the web preview formats a file

The server sends the same preview JSON as before. The browser does the formatting. `FilePreview.svelte` asks
`viewKind` for the view. It uses the file name and the number of characters of the text. It never looks at bytes.

A markdown file up to 100 K characters renders as markdown. A file with a known language shows in `CodeView`, with
no size limit below the 512 KB cut of the server. Any other text shows in a `<pre>` up to 64 K characters. A longer
plain text shows in `CodeView` with no language, so a large file does not make a huge page. K is 1,024.

The libraries load by dynamic import, and only when a preview needs them. `marked` runs in a Web Worker and
`dompurify` runs on the main thread, both only for markdown. CodeMirror loads only for code and for the markdown
source. Each language is its own file, and it loads when a file of that language opens. None of this is in the first
page load. If an import fails, for example when the phone is offline, a code file shows as plain text, and a
language that fails shows the code without colors.

Markdown has two safety layers, and a hostile file must get past both. Layer 1 is the `marked` renderer in
`formatjobs.ts`. It shows raw HTML as text. It shows an image as a text link. It keeps a link only if its address
starts with `http://`, `https://` or `mailto:`, tested on the raw text before any decoding. It never writes a `class`.
Layer 2 is DOMPurify in `sanitize.ts`. It keeps a fixed list of tags, only `href` and `title` on links, and only the
same three address types. It adds `target="_blank"` and `rel="noopener noreferrer nofollow"` to every link. The
worker output is untrusted, so layer 2 runs on the main thread. If the worker takes more than two seconds, the page
stops it and shows plain text.

Code never goes through HTML. CodeMirror writes text nodes, so a code file cannot add an element, a handler or a link
to the page. `sanitize.ts` is the only file that makes the `SafeHtml` type. `FormattedText.svelte` takes only that
type, and it is the only file in the app that inserts HTML. `rawhtml.test.ts` fails if any other file does. Tests that
use DOMPurify run in `jsdom`. They must not run in `happy-dom`, because DOMPurify keeps a script tag there.

The code view builds only the lines in view, and it grows with the page. A swipe in the code scrolls the page. With
wrapping off, the code scrolls sideways in its own box. The colors are CSS variables of the theme, so every palette
works and a theme switch needs no rebuild. The contrast of the six colors was checked in four palettes.
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
git commit -m "docs: describe the CodeMirror code view and the formatted preview"
```

## Not in this feature

Images from the session folder, JSON and CSV views, a search box in the preview, relative links between markdown files, table alignment, colors inside markdown code blocks (rendered view), a cap above 512 KB or range requests, a focusable code view for keyboard users, and line numbers on by default (the `lineNumbers` prop exists and is off).
