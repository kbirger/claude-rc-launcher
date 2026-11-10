/** Left-aligned columns separated by two spaces. The first row is the header. */
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

const MAX_LINE = 500;

/** Makes text from another machine safe to print: control characters except tab become `?`, and the length is capped. */
export function sanitizeLine(s: string): string {
  return s.slice(0, MAX_LINE).replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, "?");
}
