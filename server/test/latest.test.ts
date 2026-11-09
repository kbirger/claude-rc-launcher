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

  test("a second call inside one hour makes no request", async () => {
    const s = setup();
    await s.latest.get();
    s.advance(59 * 60_000);
    await s.latest.get();
    expect(s.urls.length).toBe(1);
  });

  test("a call after one hour and one minute makes a request", async () => {
    const s = setup();
    await s.latest.get();
    s.advance(61 * 60_000);
    s.set("v0.9.0");
    expect((await s.latest.get()).version).toBe("0.9.0");
    expect(s.urls.length).toBe(2);
  });

  test("a failure with a cached value returns the old value", async () => {
    const s = setup();
    const first = await s.latest.get();
    s.advance(61 * 60_000);
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
});
