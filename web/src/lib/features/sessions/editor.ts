// The read-only CodeMirror editor behind CodeView.svelte. It imports CodeMirror, so only CodeView.svelte loads it, and
// only by import(). The editor builds only the lines in view, so a 512 KB file or one very long line opens at once.
// It writes text nodes, never HTML, so text from a file cannot become markup.
import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { codeHighlight, codeTheme } from "./codetheme";
import { collapsedRanges } from "./longlines";
import { tooManySpecialChars } from "./specialchars";

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

/** The start of the line at the top of the scroll box, or undefined when the box is scrolled to its start. */
function lineAtTopOfScreen(view: EditorView): number | undefined {
  const scrolledPast = view.scrollDOM.scrollTop;
  if (!(scrolledPast > 0)) return undefined;
  return view.lineBlockAtHeight(scrolledPast).from;
}

/** The note that stands for the hidden end of a long line. */
class HiddenRest extends WidgetType {
  constructor(readonly count: number) {
    super();
  }
  eq(other: HiddenRest) {
    return other.count === this.count;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-hidden-rest";
    span.textContent = ` ... ${this.count.toLocaleString("en-US")} more characters not shown`;
    return span;
  }
}

/** The hidden ends of the long lines of a text, as one decoration set (see longlines.ts). Empty for a normal text. */
function hiddenRests(text: string): DecorationSet {
  return Decoration.set(collapsedRanges(text).map((r) => Decoration.replace({ widget: new HiddenRest(r.to - r.from) }).range(r.from, r.to)));
}

export function createEditor(parent: HTMLElement, initial: EditorOptions): Editor {
  const opts = { ...initial };
  const wrapC = new Compartment();
  const langC = new Compartment();
  const numbersC = new Compartment();
  const wrapExt = () => (opts.wrap ? EditorView.lineWrapping : []);
  const numbersExt = () => (opts.lineNumbers ? lineNumbers() : []);
  const build = () => {
    const rests = hiddenRests(opts.text);
    return EditorState.create({
      doc: opts.text,
      extensions: [
        EditorView.decorations.of(rests),
        EditorView.atomicRanges.of(() => rests),
        EditorState.readOnly.of(true), // the commands refuse to change the text
        EditorView.editable.of(false), // no caret, no keyboard on a phone, no editing actions in the menu
        EditorView.contentAttributes.of({ "aria-readonly": "true", "aria-label": "File content" }),
        // Control, zero-width and bidirectional characters (NUL, U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069, U+FEFF)
        // show as a marked box with their code point in the title. Without it, "Trojan Source" tricks in untrusted code are invisible.
        // A text with more than MAX_SPECIAL_CHARS of them is not marked, because the marks are too slow to build (specialchars.ts).
        tooManySpecialChars(opts.text) ? [] : highlightSpecialChars(),
        codeTheme,
        codeHighlight,
        wrapC.of(wrapExt()),
        numbersC.of(numbersExt()),
        langC.of(opts.language ?? []),
      ],
    });
  };
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
      // Wrap changes the height of every line. CodeMirror keeps the scroll offset only roughly, because it guesses the height
      // of the lines it has not drawn: the line at the top moved by 5 to 19 lines on a 6,000 line file. We find that line
      // first and ask the view to scroll it back to the top once the new layout is known.
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
