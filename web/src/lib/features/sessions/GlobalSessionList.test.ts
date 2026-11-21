// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { HostInfo } from "../hosts";
import type { AllSessions, GlobalSession } from "./api";
import Harness from "./GlobalSessionListHarness.svelte";

const release = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn(() => release));
vi.mock("../../realtime/sessions", () => ({ connectSessions: connect }));

const hosts: HostInfo[] = [
  { id: "local", name: "hub", status: "ok" },
  { id: "nas", name: "Basement NAS", status: "ok" },
];
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
const status = (id: string, text: AllSessions["hosts"][number]["status"], error?: string) => ({
  id,
  name: id === "local" ? "hub" : "Basement NAS",
  status: text,
  ...(error ? { error } : {}),
});

const open: Array<() => void> = [];
afterEach(() => {
  for (const url of open.splice(0)) url();
  document.body.innerHTML = "";
  connect.mockClear();
  release.mockClear();
});

function show(
  data: AllSessions | undefined,
  props: Partial<ComponentProps<typeof Harness>> = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  if (data) client.setQueryData(["all-sessions"], data);
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(Harness, { target, props: { client, hosts, ...props } });
  open.push(() => unmount(item));
  flushSync();
  return target;
}

const INST = "bbbbbbbbbbbb";

/** The list of one instance: it reads the all-sessions cache and keeps the rows of that host and instance only. */
function showOne(
  data: AllSessions | undefined,
  props: Partial<ComponentProps<typeof Harness>> = {},
  instances: unknown[] | undefined = [{ id: INST, path: "/p", name: "inst-bb", state: "active", startedAt: null }],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) client.setQueryData(["all-sessions"], data);
  if (instances) client.setQueryData(["instances", "local"], instances);
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(Harness, { target, props: { client, hosts, host: "local", instance: INST, ...props } });
  open.push(() => unmount(item));
  flushSync();
  return target;
}

/** Rows of the instance INST on "local", next to a row of another instance on "local" and a row of INST on "nas". */
const mixed = (mine: GlobalSession[], over: Partial<AllSessions> = {}): AllSessions => ({
  sessions: [...mine, row("other-inst", "local", {}, "cccccccccccc"), row("other-host", "nas", {}, INST)],
  hosts: [status("local", "ok"), status("nas", "ok")],
  ...over,
});
const titles = (item: HTMLElement) =>
  [...item.querySelectorAll("[data-session-title]")].map((event) => event.textContent);

test("shows sessions from all nodes with the running one first", () => {
  const item = show({
    sessions: [
      row("old", "local", { lastActiveAt: "2026-11-01T00:00:00.000Z" }),
      row("nas1", "nas", { lastActiveAt: "2026-11-19T11:00:00.000Z" }),
      row("busy", "nas", { live: { status: "busy", remoteControl: false }, lastActiveAt: "2026-10-01T00:00:00.000Z" }),
    ],
    hosts: [status("local", "ok"), status("nas", "ok")],
  });
  expect(titles(item)).toEqual(["title-busy", "title-nas1", "title-old"]);
});

test("a row shows the node name and the instance name, and links to the session", () => {
  const item = show({ sessions: [row("11111111-2222-3333-4444-555555555555", "nas")], hosts: [status("nas", "ok")] });
  expect(item.textContent).toContain("Basement NAS");
  expect(item.textContent).toContain("inst-01");
  const left = item.querySelector("ul a") as HTMLAnchorElement;
  expect(left.getAttribute("href")).toBe(
    "/sessions?host=nas&instance=0123456789ab&session=11111111-2222-3333-4444-555555555555",
  );
});

test("the node selection keeps only the rows of the selected nodes", () => {
  const item = show(
    { sessions: [row("a", "local"), row("b", "nas")], hosts: [status("local", "ok"), status("nas", "ok")] },
    { nodes: ["nas"] },
  );
  expect(titles(item)).toEqual(["title-b"]);
});

test("ticking a node in the node filter calls ontoggle", async () => {
  const ontoggle = vi.fn();
  const item = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] }, { ontoggle });

  const mouse = (el: Element, ...types: string[]) => {
    for (const type of types)
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", button: 0 }));
  };

  mouse(item.querySelector('button[aria-label="Filter by node"]')!, "pointerdown");
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const el = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((index) =>
    index.textContent?.includes("Basement NAS"),
  ) as HTMLElement;
  mouse(el, "pointermove", "pointerdown", "pointerup");
  el.click();
  await vi.waitFor(() => expect(ontoggle).toHaveBeenCalledWith("nas"));
});

test("the text filter matches the node name", () => {
  const item = show({
    sessions: [row("a", "local"), row("b", "nas")],
    hosts: [status("local", "ok"), status("nas", "ok")],
  });
  const input = item.querySelector("input[type=search]") as HTMLInputElement;
  input.value = "basement";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(titles(item)).toEqual(["title-b"]);
});

test("two sessions with the same id on two nodes both show", () => {
  const item = show({
    sessions: [row("same", "local"), row("same", "nas")],
    hosts: [status("local", "ok"), status("nas", "ok")],
  });
  expect(titles(item)).toEqual(["title-same", "title-same"]);
});

test("an offline node and an unavailable node appear in a notice and the other rows still show", () => {
  const three: HostInfo[] = [...hosts, { id: "old", name: "Old box", status: "ok" }];
  const item = show(
    {
      sessions: [row("a", "local")],
      hosts: [
        status("local", "ok"),
        { id: "nas", name: "Basement NAS", status: "offline", error: "unreachable" },
        { id: "old", name: "Old box", status: "unavailable" },
      ],
    },
    { hosts: three },
  );
  expect(titles(item)).toEqual(["title-a"]);
  expect(item.textContent).toContain("Basement NAS: not answering");
  expect(item.textContent).toContain("Old box: no session files on this node");
});

test("a node that is not in the selection gives no notice", () => {
  const item = show(
    { sessions: [row("a", "local")], hosts: [status("local", "ok"), status("nas", "offline", "unreachable")] },
    { nodes: ["local"] },
  );
  expect(item.textContent).not.toContain("not answering");
});

test("for one instance the heading names the instance and the node, and there is no node filter and no chip", () => {
  const item = showOne(mixed([row("b", "local", {}, INST)]));
  expect(titles(item)).toEqual(["title-b"]);
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Sessions: inst-bb on hub");
  expect(item.querySelector('button[aria-label="Filter by node"]')).toBeNull();
  expect(item.querySelector('a[aria-label="Remove instance filter"]')).toBeNull();
  expect(item.querySelector("input[type=search]")).not.toBeNull();
});

test("rows show the node and instance in the all-sessions list, but not for one instance", () => {
  const data = { sessions: [row("a", "local", {}, "aaaaaaaaaaaa")], hosts: [status("local", "ok")] };
  expect(show(data).querySelector("[data-session-where]")!.textContent).toContain("hub");
  expect(showOne(mixed([row("a", "local", {}, INST)])).querySelector("[data-session-where]")).toBeNull();
});

test("for one instance the node selection is ignored", () => {
  const item = showOne(mixed([row("a", "local", {}, INST)]), { nodes: ["nas"] });
  expect(titles(item)).toEqual(["title-a"]);
});

test("the Sessions page opens the stream at mount and releases it at unmount", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  show({ sessions: [], hosts: [] }, {}, client);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledWith(client);
  expect(release).not.toHaveBeenCalled();
  for (const url of open.splice(0)) url();
  expect(release).toHaveBeenCalledTimes(1);
});

test("the one-instance page shows only the rows of that host and instance from the cache", () => {
  const item = showOne(
    mixed([row("mine1", "local", {}, INST), row("mine2", "local", { lastActiveAt: "2026-11-19T11:00:00.000Z" }, INST)]),
  );
  expect(titles(item)).toEqual(["title-mine2", "title-mine1"]);
  expect(item.textContent).toContain("2 sessions");
});

test("the one-instance page shows the status notice of its host only", () => {
  const item = showOne(
    mixed([], { hosts: [status("local", "offline", "unreachable"), status("nas", "error", "boom")] }),
  );
  expect(item.textContent).toContain("hub: not answering");
  expect(item.textContent).not.toContain("boom");
  expect(item.textContent).not.toContain("No sessions yet.");
});

test("notice texts: unavailable, loading, offline, error", () => {
  const four: HostInfo[] = [
    { id: "a", name: "A", status: "ok" },
    { id: "b", name: "B", status: "ok" },
    { id: "c", name: "C", status: "ok" },
    { id: "d", name: "D", status: "ok" },
  ];
  const item = show(
    {
      sessions: [],
      hosts: [
        { id: "a", name: "A", status: "unavailable" },
        { id: "b", name: "B", status: "loading" },
        { id: "c", name: "C", status: "offline", error: "unreachable" },
        { id: "d", name: "D", status: "error", error: "host d: timeout" },
      ],
    },
    { hosts: four },
  );
  expect(item.textContent).toContain("A: no session files on this node");
  expect(item.textContent).toContain("B: loading");
  expect(item.textContent).toContain("C: not answering");
  expect(item.textContent).toContain("D: host d: timeout");
  expect(item.textContent!.toLowerCase()).not.toContain("update");
});

test("a failed read of the list shows the error", async () => {
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "hub: store gone" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );

  try {
    const item = showOne(undefined);
    await vi.waitFor(() => expect(item.textContent).toContain("hub: store gone"));
  } finally {
    globalThis.fetch = real;
  }
});

test("a failed refresh keeps the rows and shows no error", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const item = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] }, {}, client);
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "hub: store gone" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );

  try {
    await client.invalidateQueries({ queryKey: ["all-sessions"] });
    flushSync();
    expect(client.getQueryState(["all-sessions"])!.error).not.toBeNull();
    expect(titles(item)).toEqual(["title-a"]);
    expect(item.textContent).not.toContain("hub: store gone");
  } finally {
    globalThis.fetch = real;
  }
});

test("for one instance with no sessions the heading takes the instance name from the instance list", () => {
  const item = showOne(mixed([]));
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Sessions: inst-bb on hub");
  expect(item.textContent).toContain("No sessions yet.");
});

test("the heading says Sessions when no instance is chosen", () => {
  const item = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] });
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Sessions");
});

test("says no sessions yet when there are no rows and no notice", () => {
  const item = show({ sessions: [], hosts: [status("local", "ok")] });
  expect(item.textContent).toContain("No sessions yet.");
});

test("says that no session matches the filter", () => {
  const item = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] });
  const input = item.querySelector("input[type=search]") as HTMLInputElement;
  input.value = "zzz";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(item.textContent).toContain('No session matches "zzz".');
});

test("two nodes with the same name that both fail give two notices", () => {
  const same: HostInfo[] = [
    { id: "a", name: "box", status: "ok" },
    { id: "b", name: "box", status: "ok" },
  ];
  const item = show(
    {
      sessions: [],
      hosts: [
        { id: "a", name: "box", status: "offline", error: "unreachable" },
        { id: "b", name: "box", status: "offline", error: "unreachable" },
      ],
    },
    { hosts: same },
  );
  expect(item.textContent!.match(/box: not answering/g)).toHaveLength(2);
});

test("an address with an instance and no host shows no instance chip and no filter", () => {
  const item = show(
    {
      sessions: [row("a", "local", {}, "aaaaaaaaaaaa"), row("b", "local", {}, "bbbbbbbbbbbb")],
      hosts: [status("local", "ok")],
    },
    { host: "", instance: "bbbbbbbbbbbb" },
  );
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Sessions");
  expect(titles(item)).toHaveLength(2);
});

test("the filter bar sticks to the top on a phone, where the header is hidden, and under the header from 481 px", () => {
  const item = show({ sessions: [row("a", "local")], hosts: [status("local", "ok")] });
  const bar = item.querySelector("input[type=search]")!.closest(".sticky") as HTMLElement;
  expect(bar.className).toContain("top-[env(safe-area-inset-top)]");
  expect(bar.className).toContain("min-[481px]:top-[61px]");
  expect(bar.className).not.toMatch(/(^|\s)top-\[61px\]/);
});
