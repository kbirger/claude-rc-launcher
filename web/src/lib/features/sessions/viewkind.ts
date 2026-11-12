// Decides how the preview shows a text file. Pure: no DOM, no libraries, so the preview page can import it without
// loading the markdown or color code. The grammar ids are the file names under highlight.js/lib/languages.

/** Largest text, in characters of the string (not bytes), that is rendered as markdown. 100 K, where K is 1024. */
export const MARKDOWN_LIMIT = 100 * 1024;
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
