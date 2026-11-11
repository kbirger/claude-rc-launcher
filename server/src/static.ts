import type { MiddlewareHandler } from "hono";

export type WebFile = { path: string; type: string };
export type WebFiles = Map<string, WebFile>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json; charset=utf-8",
  woff2: "font/woff2",
  map: "application/json; charset=utf-8",
};

export function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

const hasExtension = (p: string) => /\.[A-Za-z0-9]+$/.test(p.slice(p.lastIndexOf("/") + 1));

/** Decode once; null when the path is unsafe (bad encoding, NUL, backslash, `..` segment). */
function safePath(raw: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes("\0") || p.includes("\\")) return null;
  if (p.split("/").includes("..")) return null;
  return p;
}

/** Serves only files present in `files` (never touches disk by user-supplied name); SPA fallback to /index.html. */
export function staticHandler(files: WebFiles): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const safe = safePath(new URL(c.req.url).pathname);
    let key = safe === null || safe === "/" ? "/index.html" : safe;
    let entry = files.get(key);
    if (!entry) {
      if (safe !== null && hasExtension(safe)) return c.text("Not Found", 404);
      key = "/index.html";
      entry = files.get(key);
      if (!entry) return c.text("Not Found", 404);
    }
    const cache = key.startsWith("/assets/") || key.startsWith("/_app/immutable/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(c.req.method === "HEAD" ? null : Bun.file(entry.path), {
      headers: { "Content-Type": entry.type, "Cache-Control": cache },
    });
  };
}
