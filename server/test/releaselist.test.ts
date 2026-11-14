import { describe, expect, test } from "bun:test";
import { createReleaseList } from "../src/releaselist";

type Rel = { tag_name: string; draft?: boolean; prerelease?: boolean };
const four: Rel[] = ["v0.22.3", "v0.22.2", "v0.22.1", "v0.22.0"].map((tag_name) => ({ tag_name }));

function setup(releases: Rel[] | Error = four) {
  let now = Date.parse("2026-11-13T00:00:00Z");
  const urls: string[] = [];
  let next: Rel[] | Error = releases;
  const fetchFake = (async (url: any) => {
    urls.push(String(url));
    if (next instanceof Error) throw next;
    return new Response(
      JSON.stringify(next.map((r) => ({ name: r.tag_name, body: `notes ${r.tag_name}`, html_url: `https://example/${r.tag_name}`, published_at: "2026-11-01T00:00:00Z", ...r }))),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const list = createReleaseList({ fetch: fetchFake, now: () => now });
  return { list, urls, advance: (ms: number) => { now += ms; }, set: (v: Rel[] | Error) => { next = v; } };
}

describe("createReleaseList", () => {
  test("returns the releases above from up to and including to, newest first", async () => {
    const r = await setup().list.between("0.22.0", "0.22.2");
    expect(r.releases.map((x) => x.version)).toEqual(["0.22.2", "0.22.1"]);
    expect(r.complete).toBe(true);
    expect(r.releases[0]).toEqual({ version: "0.22.2", name: "v0.22.2", body: "notes v0.22.2", url: "https://example/v0.22.2", publishedAt: "2026-11-01T00:00:00Z" });
  });

  test("a local build counts as its release", async () => {
    const r = await setup().list.between("0.22.1+feat-x.abc123", "0.22.3");
    expect(r.releases.map((x) => x.version)).toEqual(["0.22.3", "0.22.2"]);
    expect(r.complete).toBe(true);
  });

  test("from equal to to gives an empty list and complete true", async () => {
    expect(await setup().list.between("0.22.1", "0.22.1")).toEqual({ releases: [], complete: true });
  });

  test("from newer than the whole list gives an empty list and complete false", async () => {
    expect(await setup().list.between("0.23.0", "0.24.0")).toEqual({ releases: [], complete: false });
  });

  test("from not in the list gives the known newer releases and complete false", async () => {
    const r = await setup().list.between("0.21.0", "0.22.1");
    expect(r.releases.map((x) => x.version)).toEqual(["0.22.1", "0.22.0"]);
    expect(r.complete).toBe(false);
  });

  test("an unknown version such as dev gives an empty list and complete true", async () => {
    const s = setup();
    expect(await s.list.between("dev", "0.22.3")).toEqual({ releases: [], complete: true });
    expect(await s.list.between("0.22.0", "dev")).toEqual({ releases: [], complete: true });
  });

  test("skips drafts and prereleases", async () => {
    const r = await setup([{ tag_name: "v0.22.3", draft: true }, { tag_name: "v0.22.2", prerelease: true }, { tag_name: "v0.22.1" }, { tag_name: "v0.22.0" }]).list.between("0.22.0", "0.22.3");
    expect(r.releases.map((x) => x.version)).toEqual(["0.22.1"]);
  });

  test("one fetch serves two calls inside the cache time, and a failure serves the last good list and does not call again for 60 seconds", async () => {
    const s = setup();
    await s.list.between("0.22.0", "0.22.3");
    s.advance(4 * 60_000);
    await s.list.between("0.22.0", "0.22.3");
    expect(s.urls.length).toBe(1);
    s.advance(2 * 60_000);
    s.set(new Error("offline"));
    const r = await s.list.between("0.22.0", "0.22.3");
    expect(r.releases.length).toBe(3);
    expect(s.urls.length).toBe(2);
    s.advance(30_000);
    expect((await s.list.between("0.22.0", "0.22.3")).releases.length).toBe(3);
    expect(s.urls.length).toBe(2);
    s.advance(31_000);
    s.set(four);
    await s.list.between("0.22.0", "0.22.3");
    expect(s.urls.length).toBe(3);
  });

  test("with no good list and a failed fetch it gives an empty list and complete false", async () => {
    expect(await setup(new Error("offline")).list.between("0.22.0", "0.22.3")).toEqual({ releases: [], complete: false });
  });

  test("the request is for releases?per_page=100 of RELEASE_REPO", async () => {
    const s = setup();
    await s.list.between("0.22.0", "0.22.3");
    expect(s.urls).toEqual(["https://api.github.com/repos/kbirger/claude-rc-launcher/releases?per_page=100"]);
  });

  test("from above to gives an empty list and complete true, with no fetch", async () => {
    const s = setup();
    expect(await s.list.between("0.22.3", "0.22.1")).toEqual({ releases: [], complete: true });
    expect(await s.list.between("0.24.0", "0.23.0")).toEqual({ releases: [], complete: true });
    expect(s.urls.length).toBe(0);
    const down = setup(new Error("offline"));
    expect(await down.list.between("0.22.3", "0.22.1")).toEqual({ releases: [], complete: true });
    expect(down.urls.length).toBe(0);
  });
});
