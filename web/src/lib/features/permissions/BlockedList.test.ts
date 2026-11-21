// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { BlockedCall, Layer } from "./api";
import BlockedListHarness from "./BlockedListHarness.svelte";

const data = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getBlocked: async () => data.calls }));

const open: Array<() => void> = [];
afterEach(() => {
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

const call = (item: Partial<BlockedCall>): BlockedCall => ({
  id: "t",
  at: "2026-11-14T10:00:00Z",
  tool: "Bash",
  input: {},
  reason: "needs_approval",
  text: "x",
  ...item,
});

async function show(calls: BlockedCall[], layers: Layer[] | null = []) {
  data.calls = calls;
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(BlockedListHarness, {
    target,
    props: { client: createQueryClient(), layers: layers ?? undefined },
  });
  open.push(() => {
    unmount(mounted);
    target.remove();
  });
  await vi.waitFor(() => expect(target.textContent).not.toContain("Loading"));
  flushSync();
  return target;
}

test("a Bash call shows its command, the tool, the reason and the time", async () => {
  const shown = await show([call({ input: { command: "git push origin main" }, reason: "classifier" })]);
  const text = shown.textContent ?? "";
  expect(text).toContain("git push origin main");
  expect(text).toContain("Bash");
  expect(text).toContain("Auto mode");
  expect(text).toContain("10m ago");
});

test("a file tool shows its file path, and another tool shows its name", async () => {
  const shown = await show([
    call({ id: "a", tool: "Edit", input: { file_path: "/p/src/app.ts" } }),
    call({ id: "b", tool: "WebFetch", input: { url: "https://x.test" } }),
  ]);
  const text = shown.textContent ?? "";
  expect(text).toContain("/p/src/app.ts");
  expect(text).toContain("WebFetch");
});

test("each reason has its own label", async () => {
  const reasons = ["needs_approval", "user_rejected", "classifier", "deny_rule", "safety_check"] as const;
  const shown = await show(reasons.map((reason, index) => call({ id: String(index), reason })));
  const text = shown.textContent ?? "";
  for (const label of ["Needs approval", "You said no", "Auto mode", "Deny rule", "Safety check"])
    expect(text).toContain(label);
});

test("an empty list says nothing was blocked and there is no button", async () => {
  const shown = await show([]);
  expect(shown.textContent).toContain("Nothing was blocked");
  expect(shown.querySelector("button")).toBeNull();
});

test("a long command stays in the row (it wraps)", async () => {
  const shown = await show([call({ input: { command: "x".repeat(500) } })]);
  expect(shown.querySelectorAll("li")).toHaveLength(1);
});

const layer = (item: Partial<Layer> = {}): Layer => ({
  scope: "user",
  path: "/p/user.json",
  writable: true,
  state: "ok",
  hash: "h1",
  rules: [],
  warnings: [],
  ...item,
});
const allowRule = (raw: string, list: "allow" | "ask" | "deny" = "allow") => ({
  raw,
  list,
  tool: "Bash",
  scope: "user",
});
const btn = (htmlElement: HTMLElement, label: string) =>
  [...htmlElement.querySelectorAll("button")].find((button) => button.textContent?.includes(label));
const body = () => document.body.textContent ?? "";

test("the Allow button shows on needs_approval, user_rejected and classifier, and not on deny_rule or safety_check", async () => {
  const reasons = ["needs_approval", "user_rejected", "classifier", "deny_rule", "safety_check"] as const;
  const shown = await show(
    reasons.map((reason, index) => call({ id: String(index), reason, input: { command: `cmd${index}` } })),
  );
  const rows = [...shown.querySelectorAll("li")];
  expect(rows.map((row) => !!btn(row, "Allow..."))).toEqual([true, true, true, false, false]);
});

test("the Allow button opens the sheet in add mode with the first suggestion, and nothing is mounted before", async () => {
  const shown = await show([call({ input: { command: "git push origin main" } })], [layer()]);
  expect(document.querySelector("#rule-input")).toBeNull();
  btn(shown, "Allow...")!.click();
  flushSync();
  expect(body()).toContain("Add a rule");
  expect(document.querySelector<HTMLInputElement>("#rule-input")!.value).toBe("Bash(git push origin main)");
});

test("a user_rejected call needs a second tap before it can be saved", async () => {
  const shown = await show([call({ reason: "user_rejected", input: { command: "ls" } })], [layer()]);
  btn(shown, "Allow...")!.click();
  flushSync();
  expect(btn(document.body, "Save")).toBeUndefined();
  btn(document.body, "I understand")!.click();
  flushSync();
  expect(btn(document.body, "Save")).toBeDefined();
});

test("a call with a matching allow rule shows probably fixed and keeps its button", async () => {
  const shown = await show(
    [call({ id: "a", input: { command: "git push origin main" } }), call({ id: "b", input: { command: "rm x" } })],
    [layer({ rules: [allowRule("Bash(git push *)")] })],
  );
  const [item, htmlliElement] = [...shown.querySelectorAll("li")];
  expect(item!.textContent).toContain("probably fixed");
  expect(btn(item!, "Allow...")).toBeDefined();
  expect(htmlliElement!.textContent).not.toContain("probably fixed");
});

test("a deny rule call shows the rule and its file, or says a deny rule", async () => {
  const shown = await show(
    [
      call({ id: "a", reason: "deny_rule", input: { command: "rm -rf x" } }),
      call({ id: "b", reason: "deny_rule", input: { command: "zzz" } }),
    ],
    [layer({ rules: [allowRule("Bash(rm *)", "deny")] })],
  );
  const [item, htmlliElement] = [...shown.querySelectorAll("li")];
  expect(item!.textContent).toContain("Denied by Bash(rm *) in User settings");
  expect(htmlliElement!.textContent).toContain("Denied by a deny rule");
});

test("the Allow button is disabled until the layers have loaded", async () => {
  const shown = await show([call({ input: { command: "ls" } })], null);
  expect((btn(shown, "Allow...") as HTMLButtonElement).disabled).toBe(true);
});
