// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { UpdateEntry } from "./api";
import ReleaseNotesHarness from "./ReleaseNotesHarness.svelte";

vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  getReleaseNotes: async () => ({
    complete: true,
    releases: [
      { version: "0.24.0", name: "", body: "BOOM body", url: "u", publishedAt: "2026-11-12T10:00:00Z" },
      { version: "0.23.0", name: "", body: "fine **bold**", url: "u", publishedAt: "2026-11-10T10:00:00Z" },
    ],
  }),
}));
vi.mock("../sessions/markdown", async (orig) => {
  const real = await orig<typeof import("../sessions/markdown")>();
  return { ...real, renderMarkdown: (t: string) => { if (t.startsWith("BOOM")) throw new Error("render failed"); return real.renderMarkdown(t); } };
});

const open: Array<() => void> = [];
afterEach(() => { for (const o of open.splice(0)) o(); });

test("a body that makes renderMarkdown throw shows plain text while another body still renders as markdown", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const entry: UpdateEntry = { host: "local", startedAt: "2026-11-13T10:00:00Z", startedBy: "t", from: "0.22.0", to: "0.24.0", status: "updated" };
  const c = mount(ReleaseNotesHarness, { target, props: { entry } });
  open.push(() => { unmount(c); target.remove(); });
  await vi.waitFor(() => { flushSync(); expect(target.querySelector("[data-release='0.23.0'] .formatted-md strong")?.textContent).toBe("bold"); });
  expect(target.querySelector("[data-release='0.24.0'] pre")?.textContent).toBe("BOOM body");
  expect(target.querySelector("[data-release='0.24.0'] .formatted-md")).toBeNull();
});
