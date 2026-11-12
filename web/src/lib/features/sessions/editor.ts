// The read-only CodeMirror editor behind CodeView.svelte. It imports CodeMirror, so only CodeView.svelte loads it, and
// only by import(). The editor builds only the lines in view, so a 512 KB file or one very long line opens at once.
// It writes text nodes, never HTML, so text from a file cannot become markup.
import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
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

/** The start of the line at the top of the screen, or undefined when the top of the editor is on screen or below it. */
function lineAtTopOfScreen(view: EditorView): number | undefined {
  const scrolledPast = -view.documentTop;
  if (!(scrolledPast > 0)) return undefined;
  return view.lineBlockAtHeight(scrolledPast).from;
}

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
        // Control, zero-width and bidirectional characters (NUL, U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069, U+FEFF)
        // show as a marked box with their code point in the title. Without it, "Trojan Source" tricks in untrusted code are invisible.
        highlightSpecialChars(),
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
      const effects: StateEffect<unknown>[] = [wrapC.reconfigure(wrapExt())];
      // The page is the scroll container, so CodeMirror keeps no reading position of its own. Wrap changes the height
      // of every line, so without this the line at the top of the screen moves by many screens. We find that line first
      // and ask the view to scroll it back to the top once the new layout is known.
      const top = lineAtTopOfScreen(view);
      if (top !== undefined) effects.push(EditorView.scrollIntoView(top, { y: "start", yMargin: 0 }));
      view.dispatch({ effects });
    },
    setLineNumbers(on) {
      opts.lineNumbers = on;
      view.dispatch({ effects: numbersC.reconfigure(numbersExt()) });
    },
    destroy: () => view.destroy(),
  };
}
