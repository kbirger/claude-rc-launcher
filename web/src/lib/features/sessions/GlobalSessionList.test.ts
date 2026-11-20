// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { HostInfo } from "../hosts";
import type { AllSessions, GlobalSession } from "./api";
import Harness from "./GlobalSessionListHarness.svelte";

const hosts: HostInfo[] = [{ id: "local", name: "hub", status: "ok" }, { id: "nas", name: "Basement NAS", status: "ok" }];
const row = (id: string, host: string, over: Partial<GlobalSession> = {}, inst = "0123456789ab"): GlobalSession => ({
  id,
  root: "/work/proj",
  name: `title-${id}`,
  startedAt: "2026-11-19T10:00:00.000Z",
  lastActiveAt: "2026-11-19T10:00:00.000Z",
  instance: { id: inst, name: `inst-${inst.slice(0, 2)}`, path: "/p", state: "active" },
  host: { id: host, name: host === "local" ? "hub" : "Basement NAS" },
  ...over,
});
const status = (id: string, s: AllSessions["hosts"][number]["status"], error?: string) => ({ id, name: id === "local" ? "hub" : "Basement NAS", status: s, ...(error ? { error } : {}) });

const open: Array<() => void> = [];
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

function show(data: AllSessions | undefined, props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) client.setQueryData(["all-sessions"], data);
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(Harness, { target, props: { client, hosts, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}
const titles = (t: HTMLElement) => [...t.querySelectorAll("[data-session-title]")].map((e) => e.textContent);

test("shows sessions from all nodes with the running one first", () => {
  const t = show({
    sessions: [row("old", "local", { lastActiveAt: "2026-11-01T00:00:00.000Z" }), row("nas1", "nas", { lastActiveAt: "2026-11-19T11:00:00.000Z" }), row("busy", "nas", { live: { status: "busy", remoteControl: false }, lastActiveAt: "2026-10-01T00:00:00.000Z" })],
    hosts: [status("local", "ok"), status("nas", "ok")],
  });
  expect(titles(t)).toEqual(["title-busy", "title-nas1", "title-old"]);
});

test("a row shows the node name and the instance name, and links to the session", () => {
  const t = show({ sessions: [row("11111111-2222-3333-4444-555555555555", "nas")], hosts: [status("nas", "ok")] });
  expect(t.textContent).toContain("Basement NAS");
  expect(t.textContent).toContain("inst-01");
  const a = t.querySelector("ul a") as HTMLAnchorElement;
  expect(a.getAttribute("href")).toBe("/sessions?host=nas&instance=0123456789ab&session=11111111-2222-3333-4444-555555555555");
});

test("the node selection keeps only the rows of the selected nodes", () => {
  const t = show({ sessions: [row("a", "local"), row("b", "nas")], hosts: [status("local", "ok"), status("nas", "ok")] }, { nodes: ["nas"] });
  expect(titles(t)).toEqual(["title-b"]);
});

test("ticking a node in the node filter calls ontoggle", async () => {
  const ontoggle = vi.fn();
  const t = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] }, { ontoggle });
  const mouse = (el: Element, ...types: string[]) => { for (const type of types) el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", button: 0 })); };
  mouse(t.querySelector('button[aria-label="Filter by node"]')!, "pointerdown");
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const el = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((i) => i.textContent?.includes("Basement NAS")) as HTMLElement;
  mouse(el, "pointermove", "pointerdown", "pointerup");
  el.click();
  await vi.waitFor(() => expect(ontoggle).toHaveBeenCalledWith("nas"));
});

test("the text filter matches the node name", () => {
  const t = show({ sessions: [row("a", "local"), row("b", "nas")], hosts: [status("local", "ok"), status("nas", "ok")] });
  const input = t.querySelector("input[type=search]") as HTMLInputElement;
  input.value = "basement";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(titles(t)).toEqual(["title-b"]);
});

test("two sessions with the same id on two nodes both show", () => {
  const t = show({ sessions: [row("same", "local"), row("same", "nas")], hosts: [status("local", "ok"), status("nas", "ok")] });
  expect(titles(t)).toEqual(["title-same", "title-same"]);
});

test("an offline node and an unsupported node appear in a notice and the other rows still show", () => {
  const three: HostInfo[] = [...hosts, { id: "old", name: "Old box", status: "ok" }];
  const t = show(
    { sessions: [row("a", "local")], hosts: [status("local", "ok"), { id: "nas", name: "Basement NAS", status: "offline", error: "unreachable" }, { id: "old", name: "Old box", status: "unsupported" }] },
    { hosts: three },
  );
  expect(titles(t)).toEqual(["title-a"]);
  expect(t.textContent).toContain("Basement NAS: not answering");
  expect(t.textContent).toContain("Old box: update this node to list its sessions");
});

test("a node that is not in the selection gives no notice", () => {
  const t = show({ sessions: [row("a", "local")], hosts: [status("local", "ok"), status("nas", "offline", "unreachable")] }, { nodes: ["local"] });
  expect(t.textContent).not.toContain("not answering");
});

test("an instance filter shows only that instance, with a chip that links to /sessions", () => {
  const t = show({ sessions: [row("a", "local", {}, "aaaaaaaaaaaa"), row("b", "local", {}, "bbbbbbbbbbbb")], hosts: [status("local", "ok")] }, { host: "local", instance: "bbbbbbbbbbbb" });
  expect(titles(t)).toEqual(["title-b"]);
  const chip = t.querySelector('a[aria-label="Remove instance filter"]') as HTMLAnchorElement;
  expect(chip.getAttribute("href")).toBe("/sessions");
  expect(chip.textContent).toContain("inst-bb");
});

test("says no sessions yet when there are no rows and no notice", () => {
  const t = show({ sessions: [], hosts: [status("local", "ok")] });
  expect(t.textContent).toContain("No sessions yet.");
});

test("says that no session matches the filter", () => {
  const t = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] });
  const input = t.querySelector("input[type=search]") as HTMLInputElement;
  input.value = "zzz";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(t.textContent).toContain('No session matches "zzz".');
});

test("two nodes with the same name that both fail give two notices", () => {
  const same: HostInfo[] = [{ id: "a", name: "box", status: "ok" }, { id: "b", name: "box", status: "ok" }];
  const t = show({ sessions: [], hosts: [{ id: "a", name: "box", status: "offline", error: "unreachable" }, { id: "b", name: "box", status: "offline", error: "unreachable" }] }, { hosts: same });
  expect(t.textContent!.match(/box: not answering/g)).toHaveLength(2);
});

test("an address with an instance and no host shows no instance chip and no filter", () => {
  const t = show({ sessions: [row("a", "local", {}, "aaaaaaaaaaaa"), row("b", "local", {}, "bbbbbbbbbbbb")], hosts: [status("local", "ok")] }, { host: "", instance: "bbbbbbbbbbbb" });
  expect(t.querySelector('a[aria-label="Remove instance filter"]')).toBeNull();
  expect(titles(t)).toHaveLength(2);
});

test("the filter bar sticks to the top on a phone, where the header is hidden, and under the header from 481 px", () => {
  const t = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] });
  const bar = t.querySelector("input[type=search]")!.closest(".sticky") as HTMLElement;
  expect(bar.className).toContain("top-[env(safe-area-inset-top)]");
  expect(bar.className).toContain("min-[481px]:top-[61px]");
  expect(bar.className).not.toMatch(/(^|\s)top-\[61px\]/);
});
