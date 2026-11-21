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
afterEach(() => {
  for (const helper of open.splice(0)) helper();
});

const entry = (item: Partial<UpdateEntry> = {}): UpdateEntry => ({
  host: "local",
  startedAt: "2026-11-13T10:00:00Z",
  startedBy: "t",
  from: "0.22.0",
  to: "0.24.0",
  status: "updated",
  ...item,
});
const rel = (version: string, body: string, publishedAt = "2026-11-12T10:00:00Z") => ({
  version,
  name: version,
  body,
  url: `https://example.test/${version}`,
  publishedAt,
});

function show(updateEntry: UpdateEntry) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(ReleaseNotesHarness, { target, props: { entry: updateEntry } });
  open.push(() => {
    unmount(mounted);
    target.remove();
  });
  return target;
}

const settle = async (htmlElement: HTMLElement, text: string) => {
  await vi.waitFor(() => {
    flushSync();
    expect(htmlElement.textContent).toContain(text);
  });
};

test("shows one block for each release with its version and date", async () => {
  answer = async () => ({
    complete: true,
    releases: [rel("0.24.0", "# Big\n\nnew **thing**"), rel("0.23.0", "fixed it", "2026-11-10T10:00:00Z")],
  });
  const shown = show(entry());
  await settle(shown, "What changed");
  await vi.waitFor(() => {
    flushSync();
    expect(shown.querySelectorAll("[data-release]").length).toBe(2);
  });
  const blocks = Array.from(shown.querySelectorAll("[data-release]"));
  expect(blocks[0].textContent).toContain("0.24.0");
  expect(blocks[1].textContent).toContain("0.23.0");
  expect(blocks[0].querySelector("time")?.getAttribute("datetime")).toBe("2026-11-12T10:00:00Z");
  await vi.waitFor(() => {
    flushSync();
    expect(blocks[0].querySelector(".formatted-md strong")?.textContent).toBe("thing");
  });
});

test('an empty body shows "No notes."', async () => {
  answer = async () => ({ complete: true, releases: [rel("0.24.0", "  \n ")] });
  const shown = show(entry());
  await settle(shown, "No notes.");
});

test("a body with <script> or an <img> tag shows no script or img element", async () => {
  answer = async () => ({
    complete: true,
    releases: [rel("0.24.0", "hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>")],
  });
  const shown = show(entry());
  await vi.waitFor(() => {
    flushSync();
    expect(shown.querySelector(".formatted-md, pre")).not.toBeNull();
  });
  expect(shown.querySelectorAll("script, img").length).toBe(0);
  expect(shown.textContent).toContain("hello");
});

test('complete false shows "The notes are not available. Open the release page." with a link to releasePageUrl(to)', async () => {
  answer = async () => ({ complete: false, releases: [rel("0.24.0", "x")] });
  const shown = show(entry());
  await settle(shown, "The notes are not available.");
  expect(shown.textContent).toContain("The notes are not available. Open the release page.");
  expect(shown.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0",
  );
  expect(shown.querySelector("[data-release]")).toBeNull();
});

test("an empty complete answer shows the not-available line with the link, not a bare heading", async () => {
  answer = async () => ({ complete: true, releases: [] });
  const shown = show(entry());
  await settle(shown, "The notes are not available. Open the release page.");
  expect(shown.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0",
  );
  expect(shown.querySelector("[data-release]")).toBeNull();
  expect(shown.querySelectorAll("h3").length).toBe(1);
});

test("a failed call shows the same text and link, and no error banner", async () => {
  answer = async () => {
    throw new Error("boom");
  };

  const shown = show(entry());
  await settle(shown, "The notes are not available. Open the release page.");
  expect(shown.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0",
  );
  expect(shown.querySelector('[role="alert"]')).toBeNull();
  expect(shown.textContent).not.toContain("boom");
});

test("an entry with status failed renders nothing", async () => {
  const spy = vi.fn(answer);
  answer = spy;
  const shown = show(entry({ status: "failed" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  flushSync();
  expect(shown.textContent?.trim()).toBe("");
  expect(spy).not.toHaveBeenCalled();
});

test("the banner links the latest release page in a new tab", () => {
  const hosts: HostInfo[] = [
    {
      id: "local",
      name: "hub",
      status: "ok",
      version: "0.22.0",
      clientVersion: "0.22.0",
      target: "0.24.0",
      stale: true,
    },
  ];
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(UpdateBannerHarness, { target, props: { hosts } });
  open.push(() => {
    unmount(mounted);
    target.remove();
  });
  flushSync();
  const anchor = Array.from(target.querySelectorAll("a")).find(
    (htmlAnchorElement) => htmlAnchorElement.textContent?.trim() === "Release notes",
  );
  expect(anchor?.getAttribute("href")).toBe("https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.24.0");
  expect(anchor?.getAttribute("target")).toBe("_blank");
  expect(anchor?.getAttribute("rel")).toBe("noreferrer external");
});
