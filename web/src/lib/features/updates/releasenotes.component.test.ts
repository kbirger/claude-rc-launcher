// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { HostInfo } from "../hosts";
import type { ReleaseNotes, UpdateEntry } from "./api";
import ReleaseNotesHarness from "./ReleaseNotesHarness.svelte";
import UpdateBannerHarness from "./UpdateBannerHarness.svelte";

let answer: () => Promise<ReleaseNotes> = async () => ({ releases: [], complete: true });
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getReleaseNotes: () => answer() }));

const open: Array<() => void> = [];
afterEach(() => { for (const o of open.splice(0)) o(); });

const entry = (o: Partial<UpdateEntry> = {}): UpdateEntry => ({ host: "local", startedAt: "2026-11-13T10:00:00Z", startedBy: "t", from: "0.22.0", to: "0.24.0", status: "updated", ...o });
const rel = (version: string, body: string, publishedAt = "2026-11-12T10:00:00Z") => ({ version, name: version, body, url: `https://example.test/${version}`, publishedAt });

function show(e: UpdateEntry) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(ReleaseNotesHarness, { target, props: { entry: e } });
  open.push(() => { unmount(c); target.remove(); });
  return target;
}
const settle = async (t: HTMLElement, text: string) => { await vi.waitFor(() => { flushSync(); expect(t.textContent).toContain(text); }); };

test("shows one block for each release with its version and date", async () => {
  answer = async () => ({ complete: true, releases: [rel("0.24.0", "# Big\n\nnew **thing**"), rel("0.23.0", "fixed it", "2026-11-10T10:00:00Z")] });
  const t = show(entry());
  await settle(t, "What changed");
  await vi.waitFor(() => { flushSync(); expect(t.querySelectorAll("[data-release]").length).toBe(2); });
  const blocks = Array.from(t.querySelectorAll("[data-release]"));
  expect(blocks[0].textContent).toContain("0.24.0");
  expect(blocks[1].textContent).toContain("0.23.0");
  expect(blocks[0].querySelector("time")?.getAttribute("datetime")).toBe("2026-11-12T10:00:00Z");
  await vi.waitFor(() => { flushSync(); expect(blocks[0].querySelector(".formatted-md strong")?.textContent).toBe("thing"); });
});

test('an empty body shows "No notes."', async () => {
  answer = async () => ({ complete: true, releases: [rel("0.24.0", "  \n ")] });
  const t = show(entry());
  await settle(t, "No notes.");
});

test("a body with <script> or an <img> tag shows no script or img element", async () => {
  answer = async () => ({ complete: true, releases: [rel("0.24.0", "hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>")] });
  const t = show(entry());
  await vi.waitFor(() => { flushSync(); expect(t.querySelector(".formatted-md, pre")).not.toBeNull(); });
  expect(t.querySelectorAll("script, img").length).toBe(0);
  expect(t.textContent).toContain("hello");
});

test('complete false shows "The notes are not available. Open the release page." with a link to releasePageUrl(to)', async () => {
  answer = async () => ({ complete: false, releases: [rel("0.24.0", "x")] });
  const t = show(entry());
  await settle(t, "The notes are not available.");
  expect(t.textContent).toContain("The notes are not available. Open the release page.");
  expect(t.querySelector("a")?.getAttribute("href")).toBe("https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0");
  expect(t.querySelector("[data-release]")).toBeNull();
});

test("a failed call shows the same text and link, and no error banner", async () => {
  answer = async () => { throw new Error("boom"); };
  const t = show(entry());
  await settle(t, "The notes are not available. Open the release page.");
  expect(t.querySelector("a")?.getAttribute("href")).toBe("https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0");
  expect(t.querySelector('[role="alert"]')).toBeNull();
  expect(t.textContent).not.toContain("boom");
});

test("an entry with status failed renders nothing", async () => {
  const spy = vi.fn(answer);
  answer = spy;
  const t = show(entry({ status: "failed" }));
  await new Promise((r) => setTimeout(r, 20));
  flushSync();
  expect(t.textContent?.trim()).toBe("");
  expect(spy).not.toHaveBeenCalled();
});

test("the banner links the latest release page in a new tab", () => {
  const hosts: HostInfo[] = [{ id: "local", name: "hub", status: "ok", version: "0.22.0", clientVersion: "0.22.0", target: "0.24.0", stale: true }];
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(UpdateBannerHarness, { target, props: { hosts } });
  open.push(() => { unmount(c); target.remove(); });
  flushSync();
  const a = Array.from(target.querySelectorAll("a")).find((x) => x.textContent?.trim() === "Release notes");
  expect(a?.getAttribute("href")).toBe("https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0");
  expect(a?.getAttribute("target")).toBe("_blank");
  expect(a?.getAttribute("rel")).toBe("noreferrer");
});
