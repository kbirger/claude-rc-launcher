import { createHash } from "node:crypto";
import path from "node:path";

/** The GitHub repository that publishes the release assets and SHA256SUMS. */
export const RELEASE_REPO = "kbirger/claude-rc-launcher";

/** The form of a release tag, for example `v1.2.3` or `1.2.3-rc.1`. Anything else is refused before a request. */
export const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;

const RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases`;

export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * The side effects the release code needs. The caller decides whether `run` uses sudo. Tests replace all of it.
 */
export interface ReleaseIo {
  fetch: typeof fetch;
  run(args: string[], opts?: { timeoutMs?: number }): RunResult;
  writeTemp(name: string, data: Uint8Array): string;
  removeTemp(path: string): void;
}

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function get(io: Pick<ReleaseIo, "fetch">, url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await io.fetch(url);
  } catch (e) {
    throw new ReleaseError(`cannot download ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new ReleaseError(`cannot download ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Downloads one release asset and checks it against SHA256SUMS of the same release. Throws ReleaseError when the
 * tag is malformed, a download fails or the checksum does not match.
 */
export async function downloadAsset(io: Pick<ReleaseIo, "fetch">, asset: string, release?: string): Promise<Uint8Array> {
  if (release !== undefined && !RELEASE_TAG_RE.test(release)) throw new ReleaseError(`invalid release tag: ${release}`);
  const base = release === undefined ? `${RELEASE_BASE}/latest/download` : `${RELEASE_BASE}/download/${release}`;
  const [bin, sums] = await Promise.all([get(io, `${base}/${asset}`), get(io, `${base}/SHA256SUMS`)]);
  const line = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1] === asset);
  if (!line || line[0] !== sha256(bin)) {
    throw new ReleaseError(`the checksum of ${asset} does not match SHA256SUMS. Nothing was installed`);
  }
  return bin;
}

/**
 * Puts `binary` at `target` and keeps the old file as `<target>.prev`. The new file is written as `<target>.new`
 * first and then moved over `target`. On any failure `<target>.new` is removed and a ReleaseError is thrown.
 */
export function installWithBackup(io: ReleaseIo, target: string, binary: Uint8Array): void {
  const tmp = io.writeTemp(path.basename(target), binary);
  const step = (args: string[], what: string) => {
    const r = io.run(args);
    if (r.code !== 0) {
      throw new ReleaseError(`${what} failed (${args[0]} exit ${r.code})${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
    }
  };
  try {
    step(["install", "-m", "755", tmp, `${target}.new`], "installing the binary");
    step(["cp", "-p", target, `${target}.prev`], "backing up the installed binary");
    step(["mv", "-f", `${target}.new`, target], "installing the binary");
  } catch (e) {
    io.run(["rm", "-f", `${target}.new`]);
    throw e;
  } finally {
    io.removeTemp(tmp);
  }
}

/** Moves `<target>.prev` back over `target`. Returns false when that move fails. */
export function restorePrevious(io: ReleaseIo, target: string): boolean {
  return io.run(["mv", "-f", `${target}.prev`, target]).code === 0;
}
