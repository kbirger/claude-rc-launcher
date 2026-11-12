# Formatted file preview

## Why

Session files shows a file as plain text. The user reads markdown reports and source code on a phone. Plain markdown is hard to read, and plain code has no colors. This feature renders markdown and colors code in the preview screen. It needs no editor component and no server change.

## What the user sees

- A markdown file (`.md`, `.markdown`) opens rendered. A switch at the top shows the plain text instead, and back.
- A code or data file in a known language opens with colors. A switch turns line wrapping on and off. Wrapping is on by default, as the preview is today.
- Any other text file opens as plain text, as today.
- A file too large to format opens as plain text with a short note that says why.
- The Download button, the truncation note, and the binary view do not change.

## Goals

- Readable markdown on a phone: headings, lists, tables, code blocks, links, quotes, and task lists.
- Colored code for about 15 common languages and formats, chosen by the file extension.
- When a preview opens, the formatting code loads. The rest of the app does not get heavier.
- A hostile file cannot run code on the hub origin. The hub origin carries the user's login.

## Non-goals and anti-goals

- No editor, no line numbers, no search inside the file, no folding.
- No images in the first version. A markdown image shows its alt text and link, and never loads. A remote image from a hostile file can reveal the user's address. It can also let the file track the user.
- No JSON or CSV table views, no PDF viewer, no diff viewer.
- No server change. The server keeps returning the same `Preview` JSON.
- Anti-goal: raw HTML from a markdown file must never reach the page. Anti-goal: a link that runs script, such as a `javascript:` link, must never be clickable.
- Anti-goal: formatting must never freeze the phone. A big file falls back to plain text.

## Constraints

- Stack: Svelte 5, SvelteKit with the static adapter, Tailwind, Vitest. The web app has a feature folder rule: a feature imports another feature only through its `index.ts`.
- The only place in the app that inserts HTML is one small component that shows already sanitized formatted text. It has a comment that says so and a test that holds the sanitizing in place.
- Add dependencies only to `web/package.json` and commit `bun.lock`. CI installs with a frozen lock file.
- The README and `docs/session-files.md` describe the feature in plain English.

## Decisions made with the user

- Scope of the first version: markdown and code only. No images, no JSON or CSV views.
- Libraries stay small. The user said an editor component such as VS Code's is too heavy.
- The user said to go ahead without further approval until the work is ready for review.

## My calls, not agreed with the user

- Libraries: `marked` for markdown, `highlight.js` (core plus about 15 languages) for colors, and `dompurify` as a second layer of defense. A measured build gives about 26 KB gzip for markdown with the sanitizer and about 23 KB gzip for 14 languages. Both load by dynamic import on the preview page only.
- Markdown safety has two layers. First, the markdown renderer turns raw HTML into escaped text, so a `<script>` tag in a file shows as text. It renders images as text. It allows only `http`, `https`, and `mailto` links. It turns every other link into plain text. That includes relative links and `javascript:`, `data:`, and `vbscript:` links. Second, DOMPurify cleans the result with a fixed list of allowed tags and attributes. It allows no `style`, no event handlers, and no `class` except on the code color spans. Links get `target="_blank"` and `rel="noopener noreferrer nofollow"`.
- Code colors come from `highlight.js` output, which escapes its input. That output also goes through the sanitizer with only `span` and `class` allowed.
- A language is chosen by the file extension and a few well known names (for example `Dockerfile`, `Makefile`). The list is TypeScript, JavaScript, JSON, Python, Bash, YAML, HTML and XML, CSS, SQL, Go, Rust, INI and TOML, diff, and Markdown (as source). Svelte, TSX, JSX, and Vue files use the HTML or JavaScript grammar closest to them. The builder can adjust the list.
- Size limits so the phone stays responsive: markdown renders up to 64 KB of text (lowered from 100 KB on 2026-11-12, see the last section) (a measured 250 KB file took 4.4 seconds to open with the processor slowed four times), code colors apply up to 128 KB, and a larger file stays plain with a note. The preview itself is already cut at 512 KB.
- The colors are a small set of CSS rules that use the theme's existing color variables, so light and dark themes both work. No external highlight.js theme file is loaded.
- `.md` files default to the rendered view. If rendering fails for any reason, the plain text shows and no error page appears.

## Left to the builder

- The exact grammar list and the extension map, within the limit above.
- The component split, the names of the functions, and the CSS.
- The DOM environment for the sanitizer tests (a package such as `happy-dom` or `jsdom`, added as a dev dependency).
- The visual check: run the real app at phone width with Playwright, as the earlier end-to-end run did, and look at screenshots in light and dark.

## Later

- Images from the session folder through a safe route, with fixed image types and no SVG.
- JSON and CSV views, and a search box inside the preview.
- Relative links between markdown files inside a session folder.

## Change of plan (2026-11-12)

A measurement changed the code view. highlight.js froze the page on long unbroken word runs (80 seconds for a 131 KB TypeScript file made of one repeated letter). A read-only CodeMirror 6 view handled the same input, and a 2 MB file, in under 100 milliseconds, even with the processor slowed four times. It builds only the lines in view. It writes text nodes, so code never needs a sanitizer.

- The code view and the plain text view for large files use a read-only CodeMirror 6, loaded only when a preview opens. This replaces highlight.js, the code color sanitizer, and the code size limit.
- A markdown file in the Source view uses the same CodeMirror view with its markdown grammar.
- Rendered markdown keeps the plan above: the strict renderer, DOMPurify, the size limit, and a Web Worker with a two second limit around the renderer. The worker output is untrusted and the main thread sanitizes it.
- The colors come from CodeMirror's highlight style, mapped to the theme's color variables, so light and dark themes both work.
- The preview is still cut at 512 KB by the server. With a viewport view, a larger cap is possible later. A range request would also be possible. Both are out of scope here.

## Parser swap (2026-11-12)

The rendered markdown view now uses `markdown-it` in place of `marked`, and the Web Worker is gone. Markdown renders on the main thread. The libraries load by dynamic import in one lazy chunk (`markdown-it` and DOMPurify together, 130 KB, 52 KB gzip). The markdown limit is now 64 KB of text.

Why the parser changed. A benchmark with Bun on 100 KB inputs showed that `marked` and `micromark` need more than 20 seconds for `"*a_".repeat(34133)` and for `"*".repeat(102400) + "x"`. `micromark` needs 16 seconds for `"](x".repeat(34133)`. `markdown-it` stayed under 300 milliseconds on all 12 hostile inputs. `commonmark.js` stayed under 45 milliseconds but makes very deep output for nested quotes.

Why the worker is gone. A run of 557 hostile inputs in real Chromium with the processor slowed four times showed that the worker did not protect the page. It ran only the parser. DOMPurify, the insert and the page layout ran on the main thread, and they froze the page for up to 21 seconds. In the real app the worst file was a backtick and a newline repeated to 100 K characters. A second bad file was `"*a "` repeated, which makes emphasis nested 500 deep. DOMPurify needed 10 seconds for it. A normal dense document of 100 K characters took 1.2 seconds. DOMPurify needs a DOM, so it cannot run in a worker. The cost depends on the number of elements, on how deep they nest, and on long runs of letters with no space.

What protects the page now:

- The size limit is 64 K characters, so a normal document stays under one second at four times slowdown.
- A guard in `markdown.ts` runs before any rendering. It refuses a file, and the page shows plain text with the note "This file is too complex to format. Showing plain text.", when the file would make more than 4,500 elements (an inline code span counts twice), when anything nests deeper than 100 levels, when the sum of the squares of the lengths of the runs with no space is above 10,000,000 (the page lays out a long unbroken run of letters in a time that grows with the square of its length), or when the output is more than eight times longer than the input.
- A file that the guard refuses shows in the code viewer, not in a `<pre>` box, because a `<pre>` box has the same slow layout for a long unbroken run.

Result. A run of 621 inputs of at most 65,536 characters in the real app, from the start of the format job to the next paint, with the processor slowed four times: the worst case was 0.83 seconds, no input was above one second, and the worst case at normal speed was 0.25 seconds. The inputs include every family of the first run, inputs just below and above each limit of the guard, and 80 inputs that were made as dense as the guard allows. A very dense document, for example a table with thousands of cells, is refused and shows as plain text.

The same layout cost hit plain text. A text of 65,536 letters with no space took 16 seconds in a `<pre>` box at four times slowdown. So plain text now uses a `<pre>` box only up to 8 K characters and only when no line is longer than 2,000 characters. Any other plain text shows in the code viewer without a language, which builds only the lines in view.

