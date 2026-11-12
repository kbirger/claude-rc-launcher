/** Header value for a download name: a plain ASCII fallback plus the exact UTF-8 name. */
export function dispositionFor(name: string): string {
  const ascii = name.replace(/[\r\n"\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The last name of a path (relative or absolute), split on `/` and `\`. "download" when there is none. */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((s) => s !== "" && s !== "." && s !== "..");
  return parts[parts.length - 1] ?? "download";
}

/** The headers of every file download: never rendered, never sniffed, always saved. */
export function downloadHeaders(name: string, size?: string | number | null): Headers {
  const h = new Headers({
    "Content-Type": "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": dispositionFor(name),
  });
  if (size !== undefined && size !== null) h.set("Content-Length", String(size));
  return h;
}
