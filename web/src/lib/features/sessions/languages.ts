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
