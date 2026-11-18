# Diagrams in the formatted Markdown preview: ideas

Date: 2026-11-15. Status: idea only. Nothing is built. This is not a spec.

## Why

The formatted preview in the web app shows a `mermaid` code fence as plain text. The new auth architecture document has five Mermaid diagrams, and GitHub renders them, but the preview does not. The question was how to show diagrams in the preview, and whether a ready-made renderer already does text, code, and diagrams.

## How it works today

This section comes from reading the code.

- `web/src/lib/features/sessions/markdown.ts` renders every code fence as a plain `<pre><code>` block (line 116).
- The renderer has two layers. Layer 1 is a strict markdown-it renderer. Raw HTML becomes text. Images become text links. Only `http`, `https`, and `mailto` links stay links. No tag gets a class or a style. Layer 2 is `sanitizeMarkdownHtml` (DOMPurify).
- A guard in front of the renderer rejects a file that costs too much. The limits come from measurements in Chromium with the processor slowed four times, to mimic a phone. Examples: 25,000 elements took 4 to 19 seconds, emphasis nested 500 deep took 10 seconds, and one 65,000-letter word took 16 seconds.

## Why render cost matters

The preview renders on the main thread of the browser. A slow render freezes the whole page, and a frozen page cannot be stopped. The page is the control panel for sessions that run as root-equivalent on your hosts. A freeze can block you from stopping or pausing a session. The files come from session work trees, including cloned repositories and files that Claude wrote, so the input can be hostile or only badly generated. This is an availability risk and not a data theft risk. The same reasoning applies to Mermaid, because a large diagram can take seconds to lay out.

## Ready-made renderers

This list comes from memory. Nobody checked it in this project.

- Streamdown (Vercel) renders text, highlighted code, and Mermaid. It is a React library and the web app uses Svelte.
- `svelte-exmarkdown` lets you replace the renderer for each node type.
- Community markdown-it plugins add Mermaid fences.

A general renderer does not give the hardening that the preview has. The work to add the guard and the sanitizer moves around the library and does not go away. Mermaid output is SVG with styles and classes, so it cannot pass through layer 2 as it is.

## Options for the diagram step

Every option runs after the text renders. If a render fails or takes too long, the option falls back to the code block.

1. Browser, same page. Load `mermaid` with a dynamic import in its own chunk. Use `securityLevel: "strict"` and no HTML labels. Show the SVG as an `<img>` with a data URL, because scripts in an image do not run. Weakness: a slow diagram freezes the page, and a timeout cannot stop it.
2. Browser, sandboxed iframe. Use an iframe without `allow-same-origin` and a content security policy that blocks all network access. Hostile markup cannot reach the app. Weakness: this does not reliably fix the freeze. Chromium can put a cross-origin frame in its own process, but it is not certain on a phone, and iOS may not do it. Removing the frame does not stop a script that already runs on the same thread. A Web Worker can be killed, but it has no DOM, so it cannot run Mermaid or DOMPurify.
3. Hub, in a subprocess. The hub already fetches files from nodes. It renders the diagram with `mermaid-cli` (`mmdc`) in a sandboxed subprocess. It caches the SVG by the hash of the source. It sends the browser a finished image. A stuck process can be killed after a few seconds, and it holds no cookies or session. Costs: Chromium on the hub host, a start time of one or two seconds on the first render, and memory use that nobody measured.
4. Node, in a subprocess. Not recommended. Every node needs Chromium. The node then parses hostile files in the process that runs as the service user.

`mmdc` needs a headless Chromium. It is a command-line tool and not a renderer without a browser. A Rust rewrite called `mermaid-rs-renderer` possibly exists. Nobody checked how complete it is.

## Leaning

Keep the current text renderer and its guard. Add diagrams as a separate step. Options 1 and 3 are the sound ones. Option 3 is safer against freezes. Option 1 needs nothing new on the host. The user has not chosen.

## Things to settle

- Whether the hub can carry Chromium, and how much memory it uses at rest and under load.
- How a diagram counts in the guard: a cap on the number of diagrams and on the length of each source.
- The Mermaid theme in light and dark mode.
- Measure a diagram freeze on a real phone first, the way the earlier guard numbers were measured, before relying on process isolation in an iframe.
- Decide about `docs/images/auth/`. It holds rendered SVG files and `.mmd` sources, made with `mmdc` on 2026-11-15. It is either a one-off or the start of a script that renders every diagram in the docs.
