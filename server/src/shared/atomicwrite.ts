import { chmod, rename, writeFile } from "node:fs/promises";

export async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, { mode });
  if (process.platform !== "win32") await chmod(tmp, mode);
  await rename(tmp, file);
}
