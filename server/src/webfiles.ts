import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contentType } from "./static";
import type { WebFiles } from "./static";

/** Walks `dir` into a URL-path keyed map; a missing directory yields an empty map. */
export async function loadWebFilesFromDisk(dir: string): Promise<WebFiles> {
  const out: WebFiles = new Map();

  const walk = async (abs: string, url: string) => {
    for (const dirent of await readdir(abs, { withFileTypes: true })) {
      if (dirent.isDirectory()) await walk(join(abs, dirent.name), `${url}${dirent.name}/`);
      else if (dirent.isFile())
        out.set(`${url}${dirent.name}`, { path: join(abs, dirent.name), type: contentType(dirent.name) });
    }
  };

  try {
    await walk(dir, "/");
  } catch {
    return new Map();
  }

  return out;
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  return error instanceof Error && /cannot find module|module not found|could not resolve/i.test(error.message);
}

/** Embedded files (compiled binary) -> web/dist on disk (dev) -> empty. */
export async function loadWebFiles(): Promise<WebFiles> {
  try {
    // @ts-ignore embedded.ts is generated (gitignored) and may not exist in dev
    const mod = await import("./embedded");
    return mod.embeddedFiles;
  } catch (caught) {
    if (!isModuleNotFound(caught)) console.error("failed to load embedded web files:", caught);
    return loadWebFilesFromDisk(resolve(import.meta.dir, "../../web/dist"));
  }
}
