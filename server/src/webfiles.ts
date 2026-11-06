import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contentType, type WebFiles } from "./static";

/** Walks `dir` into a URL-path keyed map; a missing directory yields an empty map. */
export async function loadWebFilesFromDisk(dir: string): Promise<WebFiles> {
  const out: WebFiles = new Map();
  const walk = async (abs: string, url: string) => {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(abs, e.name), `${url}${e.name}/`);
      else if (e.isFile()) out.set(`${url}${e.name}`, { path: join(abs, e.name), type: contentType(e.name) });
    }
  };
  try {
    await walk(dir, "/");
  } catch {
    return new Map();
  }
  return out;
}

/** Embedded files (compiled binary) -> web/dist on disk (dev) -> empty. */
export async function loadWebFiles(): Promise<WebFiles> {
  try {
    // @ts-ignore embedded.ts is generated (gitignored) and may not exist in dev
    const mod = await import("./embedded");
    return mod.embeddedFiles as WebFiles;
  } catch {
    return loadWebFilesFromDisk(resolve(import.meta.dir, "../../web/dist"));
  }
}
