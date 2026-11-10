import { describe, expect, test } from "bun:test";
import { createLatestRelease, LatestError } from "../src/latest";

function setup(tag: string | Error = "v0.8.3") {
  let now = Date.parse("2026-11-09T00:00:00Z");
  const urls: string[] = [];
  let next: string | Error = tag;
  const fetchFake = (async (url: any) => {
    urls.push(String(url));
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ tag_name: next }), { status: 200 });
  }) as unknown as typeof fetch;
  const latest = createLatestRelease({ fetch: fetchFake, now: () => now });
  return { latest, urls, advance: (ms: number) => { now += ms; }, set: (v: string | Error) => { next = v; } };
}

describe("createLatestRelease", () => {
  test("a good answer drops the v and records the time", async () => {
    const s = setup();
    const r = await s.latest.get();
    expect(r).toEqual({ version: "0.8.3", checkedAt: "2026-11-09T00:00:00.000Z" });
    expect(s.urls).toEqual(["https://api.github.com/repos/kbirger/claude-rc-launcher/releases/latest"]);
    expect(s.latest.peek()).toEqual(r);
  });

  test("peek is empty before the first call", () => {
    expect(setup().latest.peek()).toBeUndefined();
  });

  test("a second call inside five minutes makes no request", async () => {
    const s = setup();
    await s.latest.get();
    s.advance(4 * 60_000);
    await s.latest.get();
    expect(s.urls.length).toBe(1);
  });

  test("a call after five minutes and one minute makes a request", async () => {
    const s = setup();
    await s.latest.get();
    s.advance(6 * 60_000);
    s.set("v0.9.0");
    expect((await s.latest.get()).version).toBe("0.9.0");
    expect(s.urls.length).toBe(2);
  });

  test("a failure with a cached value returns the old value", async () => {
    const s = setup();
    const first = await s.latest.get();
    s.advance(6 * 60_000);
    s.set(new Error("offline"));
    expect(await s.latest.get()).toEqual(first);
  });

  test("a failure with no value throws LatestError", async () => {
    const s = setup(new Error("offline"));
    await expect(s.latest.get()).rejects.toBeInstanceOf(LatestError);
  });

  test("a bad status or a missing tag is a failure", async () => {
    const bad = createLatestRelease({ fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
    await expect(bad.get()).rejects.toBeInstanceOf(LatestError);
    const none = createLatestRelease({ fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
    await expect(none.get()).rejects.toBeInstanceOf(LatestError);
  });

  test("ten concurrent calls make one request", async () => {
    const s = setup();
    const all = await Promise.all(Array.from({ length: 10 }, () => s.latest.get()));
    expect(s.urls.length).toBe(1);
    expect(new Set(all.map((r) => r.version))).toEqual(new Set(["0.8.3"]));
  });

  test("after a failure it waits 60 seconds before it calls again, and serves the stale value", async () => {
    const s = setup();
    const first = await s.latest.get();
    s.advance(6 * 60_000);
    s.set(new Error("offline"));
    expect(await s.latest.get()).toEqual(first);
    s.advance(30_000);
    expect(await s.latest.get()).toEqual(first);
    expect(s.urls.length).toBe(2);
    s.advance(31_000);
    s.set("v0.9.0");
    expect((await s.latest.get()).version).toBe("0.9.0");
    expect(s.urls.length).toBe(3);
  });

  test("with no cache a failure throws at once inside the backoff, then retries", async () => {
    const s = setup(new Error("offline"));
    await expect(s.latest.get()).rejects.toBeInstanceOf(LatestError);
    s.advance(10_000);
    await expect(s.latest.get()).rejects.toBeInstanceOf(LatestError);
    expect(s.urls.length).toBe(1);
    s.advance(51_000);
    s.set("v1.0.0");
    expect((await s.latest.get()).version).toBe("1.0.0");
    expect(s.urls.length).toBe(2);
  });

  test("a bad status or missing tag keeps the stale value", async () => {
    for (const bad of [new Response("no", { status: 500 }), new Response("{}", { status: 200 })]) {
      let calls = 0;
      let now = 0;
      const f = (async () => (calls++ === 0 ? new Response(JSON.stringify({ tag_name: "v1.2.3" })) : bad)) as unknown as typeof fetch;
      const l = createLatestRelease({ fetch: f, now: () => now });
      const first = await l.get();
      now += 3_700_000;
      expect(await l.get()).toEqual(first);
    }
  });

  test("a body that is not JSON is a LatestError", async () => {
    const l = createLatestRelease({ fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch });
    await expect(l.get()).rejects.toBeInstanceOf(LatestError);
  });
});
