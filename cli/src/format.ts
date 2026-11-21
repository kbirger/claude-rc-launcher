/** Left-aligned columns separated by two spaces. The first row is the header. */
export function table(rows: string[][]): string {
  const widths = rows[0].map((_unused, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const MAX_LINE = 500;

/** Control characters (except tab), bidi overrides and isolates, direction marks and zero-width characters. */
const UNSAFE = /[^\P{Cc}\t]|[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

/** Makes text from another machine safe to print: control, bidi and zero-width characters except tab become `?`, and the length is capped. */
export function sanitizeLine(text: string): string {
  return text.slice(0, MAX_LINE).replace(UNSAFE, "?");
}
