// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { UpdateEntry } from "./api";
import ReleaseNotesHarness from "./ReleaseNotesHarness.svelte";

vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  getReleaseNotes: async () => ({ complete: true, releases: [{ version: "0.24.0", name: "", body: "plain **one**", url: "u", publishedAt: "2026-11-12T10:00:00Z" }] }),
}));
// The markdown chunk fails to load (offline, or a stale chunk hash after a hub update).
vi.mock("../sessions/markdown", () => { throw new Error("chunk failed"); });

const open: Array<() => void> = [];
afterEach(() => { for (const o of open.splice(0)) o(); });

test("a failed markdown import shows the body as plain text", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const entry: UpdateEntry = { host: "local", startedAt: "2026-11-13T10:00:00Z", startedBy: "t", from: "0.22.0", to: "0.24.0", status: "updated" };
  const c = mount(ReleaseNotesHarness, { target, props: { entry } });
  open.push(() => { unmount(c); target.remove(); });
  await vi.waitFor(() => { flushSync(); expect(target.querySelector("pre")?.textContent).toBe("plain **one**"); });
  expect(target.querySelector("pre")?.classList.contains("whitespace-pre-wrap")).toBe(true);
  expect(target.querySelector(".formatted-md")).toBeNull();
});
