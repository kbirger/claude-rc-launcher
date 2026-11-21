import { describe, expect, test } from "bun:test";
import {
  downloadAsset,
  installWithBackup,
  ReleaseError,
  restorePrevious,
  RELEASE_REPO,
  RELEASE_TAG_RE,
  sha256,
} from "../src/release";
import type { ReleaseIo, RunResult } from "../src/release";
import { rejection } from "./support";

const BASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const ASSET = "claude-rc-linux-x64";
const BIN = new TextEncoder().encode("binary-bytes");

function fakeFetch(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const fakeFn = ((url: string | URL | Request) => {
    const text = String(url);
    requested.push(text);
    const route = routes[text];
    return Promise.resolve(route ? route() : new Response("missing", { status: 404 }));
  }) as unknown as typeof fetch;
  return { fetch: fakeFn, requested };
}

function sums(lines: Record<string, Uint8Array>) {
  return Object.entries(lines)
    .map(([name, data]) => `${sha256(data)}  ${name}`)
    .join("\n");
}

interface Call {
  args: string[];
  timeoutMs?: number;
}

function fakeIo(opts: { results?: Record<string, RunResult>; fetch?: typeof fetch } = {}) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const written: { name: string; data: Uint8Array; path: string }[] = [];
  const io: ReleaseIo = {
    fetch: opts.fetch ?? globalThis.fetch,
    run(args, runOpts) {
      calls.push({ args, timeoutMs: runOpts?.timeoutMs });
      const key = args.join(" ");
      return opts.results?.[key] ?? opts.results?.[args[0]] ?? { code: 0, stdout: "", stderr: "" };
    },
    writeTemp(name, data) {
      const item = `/tmp/fake/${name}`;
      written.push({ name, data, path: item });
      return item;
    },
    removeTemp(path) {
      removed.push(path);
    },
  };
  return { io, calls, removed, written };
}

describe("release constants", () => {
  test("the repository and the tag format are defined here", () => {
    expect(RELEASE_REPO).toBe("kbirger/claude-rc-launcher");
    expect(RELEASE_TAG_RE.test("v1.2.3")).toBe(true);
    expect(RELEASE_TAG_RE.test("1.2.3")).toBe(true);
    expect(RELEASE_TAG_RE.test("v1.2.3-rc.1")).toBe(true);
    expect(RELEASE_TAG_RE.test("v1.2.3-beta1")).toBe(true);
    expect(RELEASE_TAG_RE.test("v1.2")).toBe(false);
    expect(RELEASE_TAG_RE.test("v1.2.3/../x")).toBe(false);
    expect(RELEASE_TAG_RE.test("latest")).toBe(false);
    expect(RELEASE_TAG_RE.test("v1.2.3\n")).toBe(false);
  });
});

describe("downloadAsset", () => {
  test("fetches <base>/<asset> and <base>/SHA256SUMS for the latest release", async () => {
    const { fetch, requested } = fakeFetch({
      [`${BASE}/latest/download/${ASSET}`]: () => new Response(BIN),
      [`${BASE}/latest/download/SHA256SUMS`]: () => new Response(sums({ [ASSET]: BIN })),
    });
    const out = await downloadAsset({ fetch }, ASSET);
    expect(out).toEqual(BIN);
    expect(requested).toEqual([`${BASE}/latest/download/${ASSET}`, `${BASE}/latest/download/SHA256SUMS`]);
  });

  test("fetches from download/<tag> when a release is given", async () => {
    const { fetch, requested } = fakeFetch({
      [`${BASE}/download/v0.2.0/${ASSET}`]: () => new Response(BIN),
      [`${BASE}/download/v0.2.0/SHA256SUMS`]: () => new Response(sums({ [ASSET]: BIN })),
    });
    await downloadAsset({ fetch }, ASSET, "v0.2.0");
    expect(requested).toEqual([`${BASE}/download/v0.2.0/${ASSET}`, `${BASE}/download/v0.2.0/SHA256SUMS`]);
  });

  test("throws ReleaseError when the checksum does not match", async () => {
    const { fetch } = fakeFetch({
      [`${BASE}/latest/download/${ASSET}`]: () => new Response(BIN),
      [`${BASE}/latest/download/SHA256SUMS`]: () => new Response(`${"0".repeat(64)}  ${ASSET}\n`),
    });
    const err = await downloadAsset({ fetch }, ASSET).catch((error) => error);
    expect(err).toBeInstanceOf(ReleaseError);
    expect(err.message).toBe(`the checksum of ${ASSET} does not match SHA256SUMS. Nothing was installed`);
  });

  test("throws ReleaseError for HTTP 404", async () => {
    const url = `${BASE}/download/v9.9.9/${ASSET}`;
    const { fetch } = fakeFetch({
      [url]: () => new Response("nope", { status: 404 }),
      [`${BASE}/download/v9.9.9/SHA256SUMS`]: () => new Response(sums({ [ASSET]: BIN })),
    });
    const err = await downloadAsset({ fetch }, ASSET, "v9.9.9").catch((error) => error);
    expect(err).toBeInstanceOf(ReleaseError);
    expect(err.message).toBe(`cannot download ${url}: HTTP 404`);
  });

  test("rejects a release that does not match RELEASE_TAG_RE before any request", async () => {
    const requested: string[] = [];
    const fakeFn = ((url: string | URL | Request) => {
      requested.push(String(url));
      return Promise.resolve(new Response(""));
    }) as unknown as typeof fetch;
    expect(await rejection(downloadAsset({ fetch: fakeFn }, ASSET, "../../evil"))).toBeInstanceOf(ReleaseError);
    expect(requested).toEqual([]);
  });
});

describe("installWithBackup", () => {
  const TARGET = "/usr/local/bin/claude-rc-launcher";

  test("runs install, cp -p, mv in that order and returns normally", () => {
    const { io, calls, removed, written } = fakeIo();
    installWithBackup(io, TARGET, BIN);
    expect(calls.map((call) => call.args)).toEqual([
      ["install", "-m", "755", "/tmp/fake/claude-rc-launcher", `${TARGET}.new`],
      ["cp", "-p", TARGET, `${TARGET}.prev`],
      ["mv", "-f", `${TARGET}.new`, TARGET],
    ]);
    expect(written).toHaveLength(1);
    expect(written[0].data).toEqual(BIN);
    expect(removed).toEqual(["/tmp/fake/claude-rc-launcher"]);
  });

  test("removes <target>.new and throws when install fails", () => {
    const { io, calls, removed } = fakeIo({
      results: { install: { code: 1, stdout: "", stderr: "permission denied" } },
    });
    let err: unknown;

    try {
      installWithBackup(io, TARGET, BIN);
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as Error).message).toBe("installing the binary failed (install exit 1): permission denied");
    expect(calls.map((call) => call.args)).toContainEqual(["rm", "-f", `${TARGET}.new`]);
    expect(calls.some((call) => call.args[0] === "cp" || call.args[0] === "mv")).toBe(false);
    expect(removed).toEqual(["/tmp/fake/claude-rc-launcher"]);
  });

  test("leaves .prev alone when the first step fails", () => {
    const { io, calls } = fakeIo({
      results: { install: { code: 1, stdout: "", stderr: "" } },
    });
    expect(() => {
      installWithBackup(io, TARGET, BIN);
    }).toThrow(ReleaseError);
    expect(calls.map((call) => call.args)).not.toContainEqual(["cp", "-p", TARGET, `${TARGET}.prev`]);
    expect(calls.map((call) => call.args)).not.toContainEqual(["mv", "-f", `${TARGET}.prev`, TARGET]);
  });
});

describe("restorePrevious", () => {
  const TARGET = "/usr/local/bin/claude-rc-launcher";

  test("moves .prev back over the target and returns true", () => {
    const { io, calls } = fakeIo();
    expect(restorePrevious(io, TARGET)).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([["mv", "-f", `${TARGET}.prev`, TARGET]]);
  });

  test("returns false when mv fails", () => {
    const { io } = fakeIo({ results: { mv: { code: 1, stdout: "", stderr: "no such file" } } });
    expect(restorePrevious(io, TARGET)).toBe(false);
  });
});
