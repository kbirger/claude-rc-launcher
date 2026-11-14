// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { BlockedCall, Layer } from "./api";
import RuleSheetHarness from "./RuleSheetHarness.svelte";

const realFetch = globalThis.fetch;
let sent: { url: string; method?: string; body: any }[] = [];
let status = 200;
const open: Array<() => void> = [];
beforeEach(() => {
  sent = [];
  status = 200;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(status === 200 ? { scope: "user" } : { error: "changed" }), { status, headers: { "content-type": "application/json" } });
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

const layer = (scope: Layer["scope"], o: Partial<Layer> = {}): Layer => ({ scope, path: `/p/${scope}.json`, writable: true, state: "ok", hash: `hash-${scope}`, rules: [], warnings: [], ...o });
const call = (o: Partial<BlockedCall> = {}): BlockedCall => ({ id: "t", at: "2026-11-14T10:00:00Z", tool: "Bash", input: { command: "git push origin main" }, reason: "needs_approval", text: "secret denial text", ...o });

function show(props: Record<string, unknown>, client = createQueryClient()) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(RuleSheetHarness, { target, props: { host: "h", instance: "i", session: "s1", layers: [layer("user"), layer("project"), layer("local")], mode: "add", client, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return client;
}
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const field = () => document.querySelector<HTMLInputElement>("input[aria-label='Rule']")!;
const type = (v: string) => { const f = field(); f.value = v; f.dispatchEvent(new Event("input", { bubbles: true })); flushSync(); };
const closed = () => document.querySelector("[data-testid=open]")?.textContent === "closed";

test("only writable files in state ok or missing are offered, and a link shows its real path", () => {
  show({ layers: [layer("user"), layer("project", { writable: false }), layer("local", { state: "missing", hash: undefined }), layer("legacy-local", { state: "invalid", reason: "bad json" }), layer("managed", { state: "unknown-path", path: null, reason: "Claude Code keeps this file somewhere else" })] });
  const radios = [...document.querySelectorAll<HTMLInputElement>("input[name=file]")];
  expect(radios.map((r) => r.value)).toEqual(["user", "local"]);
  expect(text()).toContain("/p/user.json");
  expect(text()).toContain("Claude Code keeps this file somewhere else");
});

test("a link file shows the resolved path too", () => {
  show({ layers: [layer("user", { resolvedPath: "/real/user.json" })] });
  expect(text()).toContain("/real/user.json");
});

test("without a session only the user file is offered", () => {
  show({ session: undefined });
  expect([...document.querySelectorAll<HTMLInputElement>("input[name=file]")].map((r) => r.value)).toEqual(["user"]);
});

test("the confirm line shows the exact path and rule", () => {
  show({ initial: { raw: "Bash(ls)", list: "allow" } });
  expect(text()).toContain("Add `Bash(ls)` to Allow in `/p/user.json`");
});

test("the user and project warnings show for the chosen file", () => {
  show({});
  expect(text()).toContain("This applies to every project of this user.");
  const project = document.querySelector<HTMLInputElement>("input[name=file][value=project]")!;
  project.click();
  flushSync();
  expect(text()).toContain("This changes a file that git tracks. You must commit it.");
  expect(text()).not.toContain("This applies to every project of this user.");
});

test("a call starts the rule at the first suggestion, the others are chips with a broad label", () => {
  show({ call: call() });
  expect(field().value).toBe("Bash(git push origin main)");
  expect(button("Bash(git push *)")).toBeDefined();
  expect(text()).toContain("broad");
  button("Bash(git push *)")!.click();
  flushSync();
  expect(field().value).toBe("Bash(git push *)");
});

test("the note about trying again shows when a call is given, and the call text only in a closed details", () => {
  show({ call: call() });
  expect(text()).toContain("The session needs a message to try again.");
  const d = document.querySelector("details");
  expect(d?.open).toBe(false);
  expect(d?.textContent).toContain("secret denial text");
});

test("the classifier warning shows for a classifier call", () => {
  show({ call: call({ reason: "classifier" }) });
  expect(text()).toContain("The auto mode classifier denied this call. An allow rule may not change that.");
});

test("the edited text is what the sheet sends, with the file hash", async () => {
  show({ call: call() });
  type("Bash(git push origin dev)");
  button("Save")!.click();
  await vi.waitFor(() => expect(closed()).toBe(true));
  expect(sent[0]).toEqual({ url: "/api/hosts/h/instances/i/sessions/s1/permissions/rules", method: "POST", body: { scope: "user", list: "allow", rule: "Bash(git push origin dev)", expectedHash: "hash-user" } });
});

test("a missing file sends a null hash", async () => {
  show({ layers: [layer("local", { state: "missing", hash: undefined })], initial: { raw: "X", list: "ask" } });
  button("Save")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.body).toEqual({ scope: "local", list: "ask", rule: "X", expectedHash: null });
});

test("the save button is off for an empty rule", () => {
  show({});
  expect(button("Save")!.disabled).toBe(true);
  type("  ");
  expect(button("Save")!.disabled).toBe(true);
  type("Read");
  expect(button("Save")!.disabled).toBe(false);
});

test("a rejected call needs an extra tap before the save button works", async () => {
  show({ call: call({ reason: "user_rejected" }) });
  expect(button("Save")).toBeUndefined();
  button("I understand, you rejected this call")!.click();
  flushSync();
  expect(button("I understand, you rejected this call")).toBeUndefined();
  button("Save")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
});

test("a 409 shows the reload message, keeps the sheet open and refreshes the queries", async () => {
  status = 409;
  const client = createQueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  show({ initial: { raw: "Read", list: "allow" } }, client);
  button("Save")!.click();
  await vi.waitFor(() => expect(text()).toContain("The file changed. Reload."));
  expect(closed()).toBe(false);
  expect(spy).toHaveBeenCalled();
});

test("after success the sheet closes and the queries are invalidated", async () => {
  const client = createQueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  show({ initial: { raw: "Read", list: "allow" } }, client);
  button("Save")!.click();
  await vi.waitFor(() => expect(closed()).toBe(true));
  expect(spy.mock.calls.map((c) => (c[0] as any).queryKey[0])).toEqual(["permissions", "session-permissions", "session-blocked"]);
});

test("remove mode sends DELETE and shows the Remove line", async () => {
  show({ mode: "remove", initial: { raw: "Read", list: "deny" } });
  expect(text()).toContain("Remove `Read` from Deny in `/p/user.json`");
  button("Remove")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.method).toBe("DELETE");
  expect(sent[0]!.body.list).toBe("deny");
});
