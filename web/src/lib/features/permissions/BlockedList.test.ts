// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { BlockedCall } from "./api";
import BlockedListHarness from "./BlockedListHarness.svelte";

const data = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getBlocked: async () => data.calls }));

const open: Array<() => void> = [];
afterEach(() => { for (const u of open.splice(0)) u(); });

const call = (o: Partial<BlockedCall>): BlockedCall => ({ id: "t", at: "2026-11-14T10:00:00Z", tool: "Bash", input: {}, reason: "needs_approval", text: "x", ...o });

async function show(calls: BlockedCall[]) {
  data.calls = calls;
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(BlockedListHarness, { target, props: { client: createQueryClient() } });
  open.push(() => { unmount(c); target.remove(); });
  await vi.waitFor(() => expect(target.textContent).not.toContain("Loading"));
  flushSync();
  return target;
}

test("a Bash call shows its command, the tool, the reason and the time", async () => {
  const t = await show([call({ input: { command: "git push origin main" }, reason: "classifier" })]);
  const text = t.textContent ?? "";
  expect(text).toContain("git push origin main");
  expect(text).toContain("Bash");
  expect(text).toContain("Auto mode");
  expect(text).toContain("10m ago");
});

test("a file tool shows its file path, and another tool shows its name", async () => {
  const t = await show([call({ id: "a", tool: "Edit", input: { file_path: "/p/src/app.ts" } }), call({ id: "b", tool: "WebFetch", input: { url: "https://x.test" } })]);
  const text = t.textContent ?? "";
  expect(text).toContain("/p/src/app.ts");
  expect(text).toContain("WebFetch");
});

test("each reason has its own label", async () => {
  const reasons = ["needs_approval", "user_rejected", "classifier", "deny_rule", "safety_check"] as const;
  const t = await show(reasons.map((reason, i) => call({ id: String(i), reason })));
  const text = t.textContent ?? "";
  for (const label of ["Needs approval", "You said no", "Auto mode", "Deny rule", "Safety check"]) expect(text).toContain(label);
});

test("an empty list says nothing was blocked and there is no button", async () => {
  const t = await show([]);
  expect(t.textContent).toContain("Nothing was blocked");
  expect(t.querySelector("button")).toBeNull();
});

test("a long command stays in the row (it wraps) and does not add a button", async () => {
  const t = await show([call({ input: { command: "x".repeat(500) } })]);
  expect(t.querySelectorAll("li")).toHaveLength(1);
  expect(t.querySelector("button")).toBeNull();
});
