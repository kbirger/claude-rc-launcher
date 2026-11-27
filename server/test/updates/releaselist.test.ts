import { describe, expect, test } from "bun:test";
import { createReleaseList } from "../../src/updates/releaselist";

interface Rel {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}
const four: Rel[] = ["v0.22.3", "v0.22.2", "v0.22.1", "v0.22.0"].map((tag_name) => ({ tag_name }));

function setup(releases: Rel[] | Error = four) {
  let now = Date.parse("2026-11-13T00:00:00Z");
  const urls: string[] = [];
  let next: Rel[] | Error = releases;
  const fetchFake = ((url: any) => {
    urls.push(String(url));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          next.map((rel) => ({
            name: rel.tag_name,
            body: `notes ${rel.tag_name}`,
            html_url: `https://example/${rel.tag_name}`,
            published_at: "2026-11-01T00:00:00Z",
            ...rel,
          })),
        ),
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;
  const list = createReleaseList({ fetch: fetchFake, now: () => now });
  return {
    list,
    urls,
    advance: (ms: number) => {
      now += ms;
    },
    set: (error: Rel[] | Error) => {
      next = error;
    },
  };
}

describe("createReleaseList", () => {
  test("returns the releases above from up to and including to, newest first", async () => {
    const releaseNotes = await setup().list.between("0.22.0", "0.22.2");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.22.2", "0.22.1"]);
    expect(releaseNotes.complete).toBe(true);
    expect(releaseNotes.releases[0]).toEqual({
      version: "0.22.2",
      name: "v0.22.2",
      body: "notes v0.22.2",
      url: "https://example/v0.22.2",
      publishedAt: "2026-11-01T00:00:00Z",
    });
  });

  test("a local build counts as its release", async () => {
    const releaseNotes = await setup().list.between("0.22.1+feat-x.abc123", "0.22.3");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.22.3", "0.22.2"]);
    expect(releaseNotes.complete).toBe(true);
  });

  test("from equal to to gives an empty list and complete true", async () => {
    expect(await setup().list.between("0.22.1", "0.22.1")).toEqual({ releases: [], complete: true });
  });

  test("from newer than the whole list gives an empty list and complete false", async () => {
    expect(await setup().list.between("0.23.0", "0.24.0")).toEqual({ releases: [], complete: false });
  });

  test("from not in the list gives the known newer releases and complete false", async () => {
    const releaseNotes = await setup().list.between("0.21.0", "0.22.1");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.22.1", "0.22.0"]);
    expect(releaseNotes.complete).toBe(false);
  });

  test("an unknown version such as dev gives an empty list and complete true", async () => {
    const harness = setup();
    expect(await harness.list.between("dev", "0.22.3")).toEqual({ releases: [], complete: true });
    expect(await harness.list.between("0.22.0", "dev")).toEqual({ releases: [], complete: true });
  });

  test("skips a test build even when GitHub does not mark it as a prerelease", async () => {
    const harness = setup([{ tag_name: "v0.22.3-test.ssh.5bf4ca1" }, ...four]);
    const releaseNotes = await harness.list.between("0.22.0", "0.22.3");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.22.3", "0.22.2", "0.22.1"]);
  });

  test("the notes between a test build and an older release are empty", async () => {
    const releaseNotes = await setup().list.between("0.22.4-test.ssh.5bf4ca1", "0.22.3");
    expect(releaseNotes).toEqual({ releases: [], complete: true });
  });

  test("skips drafts and prereleases", async () => {
    const releaseNotes = await setup([
      { tag_name: "v0.22.3", draft: true },
      { tag_name: "v0.22.2", prerelease: true },
      { tag_name: "v0.22.1" },
      { tag_name: "v0.22.0" },
    ]).list.between("0.22.0", "0.22.3");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.22.1"]);
  });

  test("one fetch serves two calls inside the cache time, and a failure serves the last good list and does not call again for 60 seconds", async () => {
    const harness = setup();
    await harness.list.between("0.22.0", "0.22.3");
    harness.advance(4 * 60_000);
    await harness.list.between("0.22.0", "0.22.3");
    expect(harness.urls.length).toBe(1);
    harness.advance(2 * 60_000);
    harness.set(new Error("offline"));
    const releaseNotes = await harness.list.between("0.22.0", "0.22.3");
    expect(releaseNotes.releases.length).toBe(3);
    expect(harness.urls.length).toBe(2);
    harness.advance(30_000);
    expect((await harness.list.between("0.22.0", "0.22.3")).releases.length).toBe(3);
    expect(harness.urls.length).toBe(2);
    harness.advance(31_000);
    harness.set(four);
    await harness.list.between("0.22.0", "0.22.3");
    expect(harness.urls.length).toBe(3);
  });

  test("with no good list and a failed fetch it gives an empty list and complete false", async () => {
    expect(await setup(new Error("offline")).list.between("0.22.0", "0.22.3")).toEqual({
      releases: [],
      complete: false,
    });
  });

  test("the request is for releases?per_page=100 of RELEASE_REPO", async () => {
    const harness = setup();
    await harness.list.between("0.22.0", "0.22.3");
    expect(harness.urls).toEqual(["https://api.github.com/repos/kbirger/claude-rc-launcher/releases?per_page=100"]);
  });

  test("from above to gives an empty list and complete true, with no fetch", async () => {
    const harness = setup();
    expect(await harness.list.between("0.22.3", "0.22.1")).toEqual({ releases: [], complete: true });
    expect(await harness.list.between("0.24.0", "0.23.0")).toEqual({ releases: [], complete: true });
    expect(harness.urls.length).toBe(0);
    const down = setup(new Error("offline"));
    expect(await down.list.between("0.22.3", "0.22.1")).toEqual({ releases: [], complete: true });
    expect(down.urls.length).toBe(0);
  });

  test("a to above the newest cached release forces one refresh, and the new release makes the answer complete", async () => {
    const harness = setup();
    await harness.list.between("0.22.0", "0.22.3");
    harness.advance(10_000);
    harness.set([{ tag_name: "v0.23.0" }, ...four]);
    const releaseNotes = await harness.list.between("0.22.3", "0.23.0");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.23.0"]);
    expect(releaseNotes.complete).toBe(true);
    expect(harness.urls.length).toBe(2);
  });

  test("a to that stays unlisted gives complete false and does not fetch again inside 60 seconds", async () => {
    const harness = setup();
    await harness.list.between("0.22.0", "0.22.3");
    harness.advance(10_000);
    const releaseNotes = await harness.list.between("0.22.1", "0.24.0");
    expect(releaseNotes.releases.map((releaseNote) => releaseNote.version)).toEqual(["0.22.3", "0.22.2"]);
    expect(releaseNotes.complete).toBe(false);
    expect(harness.urls.length).toBe(2);
    harness.advance(30_000);
    expect((await harness.list.between("0.22.1", "0.24.0")).complete).toBe(false);
    expect(harness.urls.length).toBe(2);
    harness.advance(31_000);
    await harness.list.between("0.22.1", "0.24.0");
    expect(harness.urls.length).toBe(3);
  });

  test("a to at or below the newest release makes no extra fetch", async () => {
    const harness = setup();
    await harness.list.between("0.22.0", "0.22.3");
    await harness.list.between("0.22.0", "0.22.2");
    await harness.list.between("0.22.1", "0.22.3");
    expect(harness.urls.length).toBe(1);
  });
});
