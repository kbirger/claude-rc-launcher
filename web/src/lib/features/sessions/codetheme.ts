// The look of CodeView: a CodeMirror theme and a highlight style that use only the CSS variables of the app theme
// (app.css and routes/layout.css). A variable is read when the browser paints, so a switch between light, dark, Ayu and
// Tokyo Night needs no rebuild of the editor. Only editor.ts imports this file, and editor.ts is loaded by import().
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

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
  "&": {
    ...PALETTE,
    backgroundColor: "transparent",
    color: "var(--foreground)",
    fontSize: "0.875rem",
    maxWidth: "100%",
    maxHeight: "calc(var(--pane-max, 100dvh) - var(--code-note, 0rem) - 2px)",
  },
  "&.cm-focused": { outline: "none" },
  // The scroller is the scroll box of the code: it scrolls in both directions inside the pane, and a fling at its end does not drag the page.
  // --pane-max is set by FilePreview. The 2 px are the border of the box around the editor. A short file is as tall as its text.
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.45",
    overflow: "auto",
    overscrollBehavior: "contain",
  },
  ".cm-content": { padding: "0.75rem" },
  ".cm-line": { padding: "0" },
  // A marked control or bidirectional character. The box and the red text use the destructive color, which has at least 3:1 against the card in every palette.
  ".cm-specialChar": {
    color: "var(--destructive)",
    outline: "1px solid var(--destructive)",
    outlineOffset: "-1px",
    borderRadius: "2px",
    backgroundColor: "color-mix(in srgb, var(--destructive) 15%, transparent)",
  },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none" },
});

export const codeHighlight: Extension = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [
        tags.keyword,
        tags.modifier,
        tags.operatorKeyword,
        tags.controlKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.self,
        tags.null,
        tags.bool,
        tags.atom,
        tags.unit,
      ],
      color: "var(--tok-keyword)",
    },
    {
      tag: [
        tags.string,
        tags.regexp,
        tags.special(tags.string),
        tags.character,
        tags.escape,
        tags.inserted,
        tags.monospace,
      ],
      color: "var(--tok-string)",
    },
    {
      tag: [tags.number, tags.integer, tags.float, tags.attributeName, tags.propertyName, tags.variableName],
      color: "var(--tok-number)",
    },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.quote],
      color: "var(--tok-comment)",
      fontStyle: "italic",
    },
    {
      tag: [
        tags.typeName,
        tags.className,
        tags.namespace,
        tags.labelName,
        tags.function(tags.variableName),
        tags.function(tags.propertyName),
        tags.definition(tags.variableName),
        tags.definition(tags.propertyName),
      ],
      color: "var(--tok-title)",
    },
    {
      tag: [tags.tagName, tags.meta, tags.processingInstruction, tags.deleted, tags.invalid, tags.angleBracket],
      color: "var(--tok-meta)",
    },
    { tag: [tags.heading, tags.strong], color: "var(--tok-title)", fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: [tags.link, tags.url], color: "var(--primary)", textDecoration: "underline" },
  ]),
);
