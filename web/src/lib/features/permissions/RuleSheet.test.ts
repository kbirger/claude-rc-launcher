// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { BlockedCall, Layer } from "./api";
import RuleSheetHarness from "./RuleSheetHarness.svelte";

const realFetch = globalThis.fetch;
let sent: { url: string; method?: string; body: any }[] = [];
let status = 200;
let answer: Record<string, unknown> = { scope: "user" };
const open: Array<() => void> = [];
beforeEach(() => {
  sent = [];
  status = 200;
  answer = { scope: "user" };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(status === 200 ? answer : { error: "changed" }), { status, headers: { "content-type": "application/json" } });
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
const group = (name: string) => [...document.querySelectorAll("[aria-labelledby]")].find((e) => document.getElementById(e.getAttribute("aria-labelledby")!)?.textContent === name) ?? null;
const items = (name: string) => [...(group(name)?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
const labels = (name: string) => items(name).map((i) => i.textContent?.trim());
const pickFile = (label: string) => { items("File").find((i) => i.textContent?.trim() === label)!.click(); flushSync(); };
const closed = () => document.querySelector("[data-testid=open]")?.textContent === "closed";

test("only writable files in state ok or missing are offered, and a link shows its real path", () => {
  show({ layers: [layer("user"), layer("project", { writable: false }), layer("local", { state: "missing", hash: undefined }), layer("legacy-local", { state: "invalid", reason: "bad json" }), layer("managed", { state: "unknown-path", path: null, reason: "Claude Code keeps this file somewhere else" })], initial: { raw: "Bash(ls)", list: "allow" } });
  expect(labels("File")).toEqual(["User", "Local"]);
  expect(text()).toContain("in /p/user.json");
  expect(text()).toContain("Claude Code keeps this file somewhere else");
});

test("a link file shows one Link to line right under the confirm line", () => {
  show({ layers: [layer("user", { resolvedPath: "/real/user.json" })], initial: { raw: "Bash(ls)", list: "allow" } });
  expect(text()).toContain("Link to /real/user.json");
  expect(text().match(/Link to/g)).toHaveLength(1);
  expect(document.querySelector("[data-testid=confirm]")!.nextElementSibling!.textContent).toBe("Link to /real/user.json");
});

test("no Link to line when the real path is the path", () => {
  show({ layers: [layer("user", { resolvedPath: "/p/user.json" })], initial: { raw: "Bash(ls)", list: "allow" } });
  expect(text()).not.toContain("Link to");
});

test("the file selector holds only short labels, no paths and no Link to", () => {
  show({ layers: [layer("user", { resolvedPath: "/real/user.json" }), layer("project")] });
  const g = group("File")!;
  expect(g).not.toBeNull();
  expect(g.textContent).not.toContain("/p/");
  expect(g.textContent).not.toContain("/real/");
  expect(g.textContent).not.toContain("Link to");
});

test("one offered file shows no selector", () => {
  show({ layers: [layer("user"), layer("project", { writable: false })], initial: { raw: "Bash(ls)", list: "allow" } });
  expect(group("File")).toBeNull();
  expect(text()).toContain("in /p/user.json");
});

test("the chosen file is exposed on the selector", async () => {
  show({ initial: { raw: "Bash(ls)", list: "allow" } });
  const user = items("File")[0]!;
  const [, project] = items("File");
  expect(user.getAttribute("aria-selected")).toBe("true");
  user.click();
  flushSync();
  expect(items("File")[0]!.getAttribute("aria-selected")).toBe("true");
  project!.click();
  flushSync();
  expect(items("File")[1]!.getAttribute("aria-selected")).toBe("true");
  items("File")[1]!.click();
  flushSync();
  expect(items("File")[1]!.getAttribute("aria-selected")).toBe("true");
  button("Save")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.body.scope).toBe("project");
});

test("each selector has a visible label, and one file hides the file label too", () => {
  show({ initial: { raw: "Bash(ls)", list: "ask" } });
  const file = [...document.querySelectorAll("span")].find((e) => e.textContent === "File")!;
  const list = [...document.querySelectorAll("span")].find((e) => e.textContent === "List")!;
  expect(file.className).toContain("font-medium");
  expect(group("File")!.getAttribute("aria-labelledby")).toBe(file.id);
  expect(group("List")!.getAttribute("aria-labelledby")).toBe(list.id);
  expect(labels("List")).toEqual(["Allow", "Ask", "Deny"]);
  expect(items("List")[1]!.getAttribute("aria-selected")).toBe("true");
  document.body.innerHTML = "";
  show({ layers: [layer("user")], initial: { raw: "Bash(ls)", list: "allow" } });
  expect([...document.querySelectorAll("span")].some((e) => e.textContent === "File")).toBe(false);
  expect([...document.querySelectorAll("span")].some((e) => e.textContent === "List")).toBe(true);
});

test("the list selector is disabled in remove mode", () => {
  show({ mode: "remove", initial: { raw: "Read", list: "deny" } });
  expect(items("List")).toHaveLength(3);
  expect(items("List").every((i) => (i as HTMLButtonElement).disabled)).toBe(true);
});

test("a file that cannot be changed is a plain note without a border box", () => {
  show({ layers: [layer("user"), layer("managed", { state: "unknown-path", path: null, reason: "Somewhere else" })], session: "s1" });
  const note = [...document.querySelectorAll("p")].find((p) => p.textContent?.includes("Somewhere else"))!;
  expect(note.className).not.toContain("border");
});

test("without a session only the user file is offered", () => {
  show({ session: undefined, initial: { raw: "Bash(ls)", list: "allow" } });
  expect(group("File")).toBeNull();
  expect(text()).toContain("in /p/user.json");
});

test("the confirm line shows the exact path and rule", () => {
  show({ initial: { raw: "Bash(ls)", list: "allow" } });
  expect(text()).toContain("Add Bash(ls) to Allow in /p/user.json");
});

test("the user and project warnings show for the chosen file", () => {
  show({});
  expect(text()).toContain("This applies to every project of this user.");
  pickFile("Project");
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

test("the call text shows only in a closed details", () => {
  show({ call: call() });
  const d = document.querySelector("details");
  expect(d?.open).toBe(false);
  expect(d?.textContent).toContain("secret denial text");
});

test("the classifier warning shows for a classifier call", () => {
  show({ call: call({ reason: "classifier" }) });
  expect(text()).toContain("Auto mode blocked this call. A narrow allow rule, like the one below, clears it. A rule that allows any command, such as Bash(*), does not.");
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
  expect(text()).toContain("Remove Read from Deny in /p/user.json");
  button("Remove")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.method).toBe("DELETE");
  expect(sent[0]!.body.list).toBe("deny");
});

test("the confirm line shows the rule and the path in code elements, with no backticks", () => {
  show({ initial: { raw: "Bash(ls)", list: "allow" } });
  const codes = [...document.querySelectorAll("[data-testid=confirm] code")].map((c) => c.textContent);
  expect(codes).toEqual(["Bash(ls)", "/p/user.json"]);
  expect(document.querySelector("[data-testid=confirm]")!.textContent).not.toContain("`");
});

test("a save from a blocked call sends exactly scope, list, rule and expectedHash, never the call text", async () => {
  show({ call: call() });
  button("Save")!.click();
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(Object.keys(sent[0]!.body).sort()).toEqual(["expectedHash", "list", "rule", "scope"]);
  expect(JSON.stringify(sent[0]!.body)).not.toContain("secret denial text");
});

test("the body follows a file switch: scope and hash of the picked file", async () => {
  show({ initial: { raw: "Bash(ls)", list: "allow" } });
  pickFile("Project");
  button("Save")!.click();
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(sent[0]!.body).toEqual({ scope: "project", list: "allow", rule: "Bash(ls)", expectedHash: "hash-project" });
});

const box = () => document.querySelector<HTMLInputElement>("input[type=checkbox]");

test("shows the checkbox on for a live session", () => {
  show({ call: call(), live: true });
  expect(text()).toContain("Tell the session to try again");
  expect(box()!.checked).toBe(true);
  expect(box()!.disabled).toBe(false);
  expect(text()).not.toContain("The session is not running.");
});

test("shows it off and disabled for a session that is not live", () => {
  show({ call: call(), live: false });
  expect(box()!.checked).toBe(false);
  expect(box()!.disabled).toBe(true);
  expect(text()).toContain("The session is not running.");
});

test("has no checkbox in remove mode", () => {
  show({ mode: "remove", call: call(), live: true, initial: { raw: "Read", list: "deny" } });
  expect(box()).toBeNull();
});

test("has no checkbox without a blocked call", () => {
  show({ live: true });
  expect(box()).toBeNull();
});

test("save sends nudge true when the box is on", async () => {
  show({ call: call(), live: true });
  button("Save")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.body.nudge).toBe(true);
});

test("save sends no nudge when the box is off", async () => {
  show({ call: call(), live: true });
  box()!.click();
  flushSync();
  button("Save")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect("nudge" in sent[0]!.body).toBe(false);
  await vi.waitFor(() => expect(closed()).toBe(true));
});

test("shows the sent text and keeps the sheet open", async () => {
  answer = { scope: "user", nudge: { sent: true } };
  show({ call: call(), live: true });
  button("Save")!.click();
  await vi.waitFor(() => expect(text()).toContain("Sent to the session. It may still wait for you to approve the message."));
  expect(closed()).toBe(false);
  expect(document.querySelector("[role=status]")).not.toBeNull();
  button("Close")!.click();
  flushSync();
  expect(closed()).toBe(true);
});

test("shows the failure text when the answer says not_live", async () => {
  answer = { scope: "user", nudge: { sent: false, reason: "not_live" } };
  show({ call: call(), live: true });
  button("Save")!.click();
  await vi.waitFor(() => expect(text()).toContain("The session is not running, so it was not told."));
  expect(closed()).toBe(false);
});

test("the result text never says received", async () => {
  for (const nudge of [{ sent: true }, { sent: false, reason: "not_live" }, { sent: false, reason: "socket_refused" }, { sent: false, reason: "send_failed" }, { sent: false, reason: "unsupported" }]) {
    answer = { scope: "user", nudge };
    show({ call: call(), live: true });
    button("Save")!.click();
    await vi.waitFor(() => expect(document.querySelector("[role=status]")).not.toBeNull());
    expect(document.body.textContent).not.toMatch(/receiv/i);
    for (const u of open.splice(0)) u();
    document.body.innerHTML = "";
  }
});

test("the status says the rule was saved, for sent and for a failure", async () => {
  for (const nudge of [{ sent: true }, { sent: false, reason: "not_live" }]) {
    answer = { scope: "user", nudge };
    show({ call: call(), live: true });
    button("Save")!.click();
    await vi.waitFor(() => expect(document.querySelector("[role=status]")).not.toBeNull());
    expect(document.querySelector("[role=status]")!.textContent).toMatch(/^Rule saved\. /);
    for (const u of open.splice(0)) u();
    document.body.innerHTML = "";
  }
});

test("an answer without a nudge key to a nudge request shows unsupported and keeps the sheet open", async () => {
  show({ call: call(), live: true });
  button("Save")!.click();
  await vi.waitFor(() => expect(document.querySelector("[role=status]")).not.toBeNull());
  expect(document.querySelector("[role=status]")!.textContent).toBe("Rule saved. This node cannot tell a session to try again.");
  expect(closed()).toBe(false);
});

const pickList = (l: string) => { items("List").find((i) => i.textContent?.trim().toLowerCase() === l)!.click(); flushSync(); };

test("the box is hidden and no nudge is sent when the list is not allow", async () => {
  show({ call: call(), live: true });
  expect(box()).not.toBeNull();
  pickList("deny");
  expect(box()).toBeNull();
  button("Save")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.body.list).toBe("deny");
  expect("nudge" in sent[0]!.body).toBe(false);
});

test("the box returns with its previous state when the list goes back to allow", () => {
  show({ call: call(), live: true });
  box()!.click();
  flushSync();
  expect(box()!.checked).toBe(false);
  pickList("ask");
  expect(box()).toBeNull();
  pickList("allow");
  expect(box()!.checked).toBe(false);
  box()!.click();
  flushSync();
  pickList("deny");
  pickList("allow");
  expect(box()!.checked).toBe(true);
});

test("the box is not shown when the sheet starts on a list other than allow", () => {
  show({ call: call(), live: true, initial: { raw: "Bash(ls)", list: "ask" } });
  expect(box()).toBeNull();
});

test("only the chosen item of each selector is selected", () => {
  show({ initial: { raw: "Bash(ls)", list: "ask" } });
  expect(items("File").map((i) => i.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  expect(items("List").map((i) => i.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
});
