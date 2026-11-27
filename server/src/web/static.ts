import type { MiddlewareHandler } from "hono";

export interface WebFile {
  path: string;
  type: string;
}
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
  webmanifest: "application/manifest+json; charset=utf-8",
  woff2: "font/woff2",
  map: "application/json; charset=utf-8",
};

/**
 * The files that a browser fetches without the login cookie when it installs the app: the manifest, its icons and the
 * service worker. They hold nothing private, and behind login they would redirect to the login page and break install.
 */
const PWA_FILES = new Set([
  "/manifest.webmanifest",
  "/service-worker.js",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
]);
export const isPwaFile = (path: string): boolean => PWA_FILES.has(path);

export function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

const hasExtension = (file: string) => /\.[A-Za-z0-9]+$/.test(file.slice(file.lastIndexOf("/") + 1));

/** Decode once; null when the path is unsafe (bad encoding, NUL, backslash, `..` segment). */
function safePath(raw: string): string | null {
  let item: string;

  try {
    item = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (item.includes("\0") || item.includes("\\")) return null;
  if (item.split("/").includes("..")) return null;
  return item;
}

/** Serves only files present in `files` (never touches disk by user-supplied name); SPA fallback to /index.html. */
export function staticHandler(files: WebFiles): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.method !== "GET" && context.req.method !== "HEAD") return next();
    const safe = safePath(new URL(context.req.url).pathname);
    let key = safe === null || safe === "/" ? "/index.html" : safe;
    let entry = files.get(key);

    if (!entry) {
      if (safe !== null && hasExtension(safe)) return context.text("Not Found", 404);
      key = "/index.html";
      entry = files.get(key);
      if (!entry) return context.text("Not Found", 404);
    }

    const cache =
      key.startsWith("/assets/") || key.startsWith("/_app/immutable/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
    return new Response(context.req.method === "HEAD" ? null : Bun.file(entry.path), {
      headers: { "Content-Type": entry.type, "Cache-Control": cache },
    });
  };
}
