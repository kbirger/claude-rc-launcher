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
  "&": { ...PALETTE, backgroundColor: "transparent", color: "var(--foreground)", fontSize: "0.875rem", maxWidth: "100%", maxHeight: "calc(var(--pane-max, 100dvh) - var(--code-note, 0rem) - 2px)" },
  "&.cm-focused": { outline: "none" },
  // The scroller is the scroll box of the code: it scrolls in both directions inside the pane, and a fling at its end does not drag the page.
  // --pane-max is set by FilePreview. The 2 px are the border of the box around the editor. A short file is as tall as its text.
  ".cm-scroller": { fontFamily: "ui-monospace, monospace", lineHeight: "1.45", overflow: "auto", overscrollBehavior: "contain" },
  ".cm-content": { padding: "0.75rem" },
  ".cm-line": { padding: "0" },
  // A marked control or bidirectional character. The box and the red text use the destructive color, which has at least 3:1 against the card in every palette.
  ".cm-specialChar": { color: "var(--destructive)", outline: "1px solid var(--destructive)", outlineOffset: "-1px", borderRadius: "2px", backgroundColor: "color-mix(in srgb, var(--destructive) 15%, transparent)" },
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
