import { describe, expect, test } from "bun:test";
import { createLatestRelease, LatestError } from "../src/latest";
import { rejection } from "./support";

function setup(tag: string | Error = "v0.8.3") {
  let now = Date.parse("2026-11-09T00:00:00Z");
  const urls: string[] = [];
  let next: string | Error = tag;
  const fetchFake = ((url: any) => {
    urls.push(String(url));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response(JSON.stringify({ tag_name: next }), { status: 200 }));
  }) as unknown as typeof fetch;
  const latest = createLatestRelease({ fetch: fetchFake, now: () => now });
  return {
    latest,
    urls,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: string | Error) => {
      next = value;
    },
  };
}

describe("createLatestRelease", () => {
  test("a good answer drops the v and records the time", async () => {
    const harness = setup();
    const latestRelease = await harness.latest.get();
    expect(latestRelease).toEqual({ version: "0.8.3", checkedAt: "2026-11-09T00:00:00.000Z" });
    expect(harness.urls).toEqual(["https://api.github.com/repos/kbirger/claude-rc-launcher/releases/latest"]);
    expect(harness.latest.peek()).toEqual(latestRelease);
  });

  test("peek is empty before the first call", () => {
    expect(setup().latest.peek()).toBeUndefined();
  });

  test("a second call inside five minutes makes no request", async () => {
    const harness = setup();
    await harness.latest.get();
    harness.advance(4 * 60_000);
    await harness.latest.get();
    expect(harness.urls.length).toBe(1);
  });

  test("a call after five minutes and one minute makes a request", async () => {
    const harness = setup();
    await harness.latest.get();
    harness.advance(6 * 60_000);
    harness.set("v0.9.0");
    expect((await harness.latest.get()).version).toBe("0.9.0");
    expect(harness.urls.length).toBe(2);
  });

  test("a failure with a cached value returns the old value", async () => {
    const harness = setup();
    const first = await harness.latest.get();
    harness.advance(6 * 60_000);
    harness.set(new Error("offline"));
    expect(await harness.latest.get()).toEqual(first);
  });

  test("a test build named as latest is refused and the last good value stays", async () => {
    const harness = setup("v0.8.3");
    const good = await harness.latest.get();
    harness.advance(400_000);
    harness.set("v0.8.4-test.ssh.5bf4ca1");
    expect(await harness.latest.get()).toEqual(good);
    const fresh = setup("v0.8.4-test.ssh.5bf4ca1");
    expect(await rejection(fresh.latest.get())).toBeInstanceOf(LatestError);
  });

  test("a failure with no value throws LatestError", async () => {
    const harness = setup(new Error("offline"));
    expect(await rejection(harness.latest.get())).toBeInstanceOf(LatestError);
  });

  test("a bad status or a missing tag is a failure", async () => {
    const bad = createLatestRelease({
      fetch: (() => Promise.resolve(new Response("no", { status: 403 }))) as unknown as typeof fetch,
    });
    expect(await rejection(bad.get())).toBeInstanceOf(LatestError);
    const none = createLatestRelease({
      fetch: (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch,
    });
    expect(await rejection(none.get())).toBeInstanceOf(LatestError);
  });

  test("ten concurrent calls make one request", async () => {
    const harness = setup();
    const all = await Promise.all(Array.from({ length: 10 }, () => harness.latest.get()));
    expect(harness.urls.length).toBe(1);
    expect(new Set(all.map((latestRelease) => latestRelease.version))).toEqual(new Set(["0.8.3"]));
  });

  test("after a failure it waits 60 seconds before it calls again, and serves the stale value", async () => {
    const harness = setup();
    const first = await harness.latest.get();
    harness.advance(6 * 60_000);
    harness.set(new Error("offline"));
    expect(await harness.latest.get()).toEqual(first);
    harness.advance(30_000);
    expect(await harness.latest.get()).toEqual(first);
    expect(harness.urls.length).toBe(2);
    harness.advance(31_000);
    harness.set("v0.9.0");
    expect((await harness.latest.get()).version).toBe("0.9.0");
    expect(harness.urls.length).toBe(3);
  });

  test("with no cache a failure throws at once inside the backoff, then retries", async () => {
    const harness = setup(new Error("offline"));
    expect(await rejection(harness.latest.get())).toBeInstanceOf(LatestError);
    harness.advance(10_000);
    expect(await rejection(harness.latest.get())).toBeInstanceOf(LatestError);
    expect(harness.urls.length).toBe(1);
    harness.advance(51_000);
    harness.set("v1.0.0");
    expect((await harness.latest.get()).version).toBe("1.0.0");
    expect(harness.urls.length).toBe(2);
  });

  test("a bad status or missing tag keeps the stale value", async () => {
    for (const bad of [new Response("no", { status: 500 }), new Response("{}", { status: 200 })]) {
      let calls = 0;
      let now = 0;
      const item = (() =>
        Promise.resolve(
          calls++ === 0 ? new Response(JSON.stringify({ tag_name: "v1.2.3" })) : bad,
        )) as unknown as typeof fetch;
      const latestRelease = createLatestRelease({ fetch: item, now: () => now });
      const first = await latestRelease.get();
      now += 3_700_000;
      expect(await latestRelease.get()).toEqual(first);
    }
  });

  test("a body that is not JSON is a LatestError", async () => {
    const latestRelease = createLatestRelease({
      fetch: (() => Promise.resolve(new Response("<html>", { status: 200 }))) as unknown as typeof fetch,
    });
    expect(await rejection(latestRelease.get())).toBeInstanceOf(LatestError);
  });
});

describe("onError", () => {
  test("reports each failed read with its message and still answers from the cache", async () => {
    const seen: string[] = [];
    let count = 0;
    const latestRelease = createLatestRelease({
      fetch: (() =>
        Promise.resolve(
          count++ === 0 ? new Response(JSON.stringify({ tag_name: "v1.0.0" })) : new Response("no", { status: 500 }),
        )) as unknown as typeof fetch,
      ttlMs: 0,
      failBackoffMs: 0,
      onError: (item) => seen.push(item),
    });
    expect((await latestRelease.get()).version).toBe("1.0.0");
    expect((await latestRelease.get()).version).toBe("1.0.0");
    expect(seen).toEqual(["GitHub answered 500"]);
  });
});
