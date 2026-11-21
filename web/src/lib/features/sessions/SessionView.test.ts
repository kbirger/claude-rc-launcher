// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { AllSessions, GlobalSession } from "./api";
import SessionViewHarness from "./SessionViewHarness.svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn(async () => {}), replaceState: vi.fn() }));
const release = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn(() => release));
vi.mock("../../realtime/sessions", () => ({ connectSessions: connect }));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  getTouched: async () => [
    { path: "/proj/src/a.ts", inside: true, tool: "write", at: "2026-11-12T10:00:00Z", confirmed: true },
  ],
}));

const open: Array<() => void> = [];
afterEach(() => {
  for (const url of open.splice(0)) url();
  document.body.innerHTML = "";
  connect.mockClear();
  release.mockClear();
});

// The harness shows host "h", instance "i", session "s1".
const row = (id: string, host: string, inst: string, name: string): GlobalSession => ({
  id,
  root: "/proj",
  name,
  startedAt: "2026-11-12T10:00:00Z",
  lastActiveAt: "2026-11-12T10:00:00Z",
  instance: { id: inst, name: inst, path: "/p", state: "active" },
  host: { id: host, name: host },
});

function show(
  data: AllSessions | undefined,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  if (data) client.setQueryData(["all-sessions"], data);
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(SessionViewHarness, { target, props: { view: "touched", client } });
  open.push(() => unmount(item));
  flushSync();
  return target;
}

test("SessionView finds the session in the all-sessions cache by host, instance and id", () => {
  const item = show({
    sessions: [
      row("s1", "other", "i", "wrong host"),
      row("s1", "h", "j", "wrong instance"),
      row("s2", "h", "i", "wrong id"),
      row("s1", "h", "i", "the one"),
    ],
    hosts: [{ id: "h", name: "box", status: "ok" }],
  });
  expect(item.querySelector("h2")!.textContent).toBe("the one");
});

test("SessionView opens the stream at mount and releases it at unmount", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  show({ sessions: [], hosts: [] }, client);
  expect(connect).toHaveBeenCalledWith(client);
  for (const url of open.splice(0)) url();
  expect(release).toHaveBeenCalledTimes(1);
});

test("SessionView shows the host status when the session is missing and the host is not ok", () => {
  const loading = show({ sessions: [], hosts: [{ id: "h", name: "box", status: "loading" }] });
  expect(loading.textContent).toContain("box: loading");
  expect(loading.textContent).not.toContain("Session not found.");
  const offline = show({
    sessions: [],
    hosts: [
      { id: "h", name: "box", status: "offline", error: "unreachable" },
      { id: "x", name: "other", status: "error", error: "boom" },
    ],
  });
  expect(offline.textContent).toContain("box: not answering");
  expect(offline.textContent).not.toContain("boom");
});

test("SessionView says the session is not found when its host is ok", () => {
  const item = show({
    sessions: [row("s1", "other", "i", "elsewhere")],
    hosts: [{ id: "h", name: "box", status: "ok" }],
  });
  expect(item.textContent).toContain("Session not found.");
  expect(item.textContent!.toLowerCase()).not.toContain("update");
});

test("SessionView keeps the session when a refresh fails", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const item = show(
    { sessions: [row("s1", "h", "i", "the one")], hosts: [{ id: "h", name: "box", status: "ok" }] },
    client,
  );
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
    expect(item.querySelector("h2")!.textContent).toBe("the one");
    expect(item.textContent).not.toContain("Could not load the session");
  } finally {
    globalThis.fetch = real;
  }
});
