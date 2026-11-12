// Decides how the preview shows a text file. Pure: no DOM, no libraries, so the preview page can import it without
// loading the markdown or code libraries. The language ids are the keys of the loaders in languages.ts.

/** Largest text, in characters of the string (not bytes), that is rendered as markdown. 64 K, where K is 1024. Measured: a normal document of this size renders in under 1 s with the processor slowed 4 times. */
export const MARKDOWN_LIMIT = 64 * 1024;
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

/** The language for a file name, or undefined. The whole name is tried first (Dockerfile, Makefile, Dockerfile.dev), then the extension. */
export function languageFor(name: string): LanguageId | undefined {
  const base = lastName(name).toLowerCase();
  if (Object.hasOwn(BY_NAME, base)) return BY_NAME[base];
  if (base.startsWith("dockerfile.")) return "dockerfile";
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
