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
- Size limits so the phone stays responsive: markdown renders up to 256 KB of text, code colors apply up to 128 KB, and a larger file stays plain with a note. The preview itself is already cut at 512 KB.
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
