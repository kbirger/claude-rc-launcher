// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Grant } from "./api";
import GrantListHarness from "./GrantListHarness.svelte";

type Call = { method: string; url: string };
const base = { nodeId: "node1", instanceId: "inst1", targetId: "nas", minutes: 60, test: false };
const GRANTS: Grant[] = [
  { ...base, id: "e1", state: "ended", requestedAt: 5, endReason: "denied" },
  { ...base, id: "a1", state: "active", requestedAt: 4, approvedAt: 4, endsAt: Date.UTC(2030, 0, 1, 12, 30) },
  { ...base, id: "p1", state: "pending", requestedAt: 3, reason: "look at logs" },
  { ...base, id: "e2", state: "ended", requestedAt: 2, endReason: "expired" },
  { ...base, id: "t1", instanceId: "test", test: true, state: "active", requestedAt: 1, endsAt: Date.UTC(2030, 0, 1) },
];

let calls: Call[];
let grants: Grant[];
let approved: Grant[];
const open: Array<() => void> = [];

beforeEach(() => {
  calls = [];
  approved = [];
  grants = GRANTS;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({ method: init?.method ?? "GET", url: path });
    const body = path === "/api/ssh/grants" ? grants : path === "/api/hosts" ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

function show() {
  const target = document.createElement("div");
  document.body.append(target);
  const client = createQueryClient();
  const mounted = mount(GrantListHarness, { target, props: { client, onapprove: (grant) => approved.push(grant) } });
  open.push(() => unmount(mounted));
  flushSync();
  return client;
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-grant]")];
const button = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;

test("GrantList shows pending before active and ended last", async () => {
  show();
  await vi.waitFor(() => expect(rows().length).toBe(5));
  expect(rows().map((row) => row.dataset.grant)).toEqual(["p1", "a1", "t1", "e1", "e2"]);
  expect(rows()[0]!.textContent).toContain("look at logs");
  expect(rows()[3]!.textContent).toContain("denied");
  expect(rows()[4]!.textContent).toContain("expired");
  expect(rows()[2]!.textContent).toContain("test");
  expect(rows()[1]!.textContent).not.toContain("test");
});

test("a pending grant has Approve and Deny, and Approve hands the grant to the page", async () => {
  show();
  await vi.waitFor(() => expect(rows().length).toBe(5));
  const [pending] = rows();
  button(pending!, "Approve").click();
  flushSync();
  expect(approved.map((grant) => grant.id)).toEqual(["p1"]);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  button(pending!, "Deny").click();
  await vi.waitFor(() => expect(calls).toContainEqual({ method: "POST", url: "/api/ssh/grants/p1/deny" }));
  expect(calls.some((call) => call.url.includes("/salt"))).toBe(false);
});

test("Revoke asks for no unlock and calls the revoke route", async () => {
  show();
  await vi.waitFor(() => expect(rows().length).toBe(5));
  const active = rows()[1]!;
  expect(active.textContent).toContain("Ends");
  button(active, "Revoke").click();
  flushSync();
  expect(calls.some((call) => call.url.endsWith("/revoke"))).toBe(false);
  await vi.waitFor(() => expect(document.querySelector("[data-slot=alert-dialog-action]")).not.toBeNull());
  document.querySelector<HTMLButtonElement>("[data-slot=alert-dialog-action]")!.click();
  await vi.waitFor(() => expect(calls).toContainEqual({ method: "POST", url: "/api/ssh/grants/a1/revoke" }));
  expect(calls.some((call) => call.url.includes("/salt") || call.url.endsWith("/approve"))).toBe(false);
});

test("the list refetches every 5 seconds while it is open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout"] });

  try {
    show();
    await vi.advanceTimersByTimeAsync(50);
    const before = calls.filter((call) => call.url === "/api/ssh/grants").length;
    expect(before).toBe(1);
    await vi.advanceTimersByTimeAsync(5100);
    expect(calls.filter((call) => call.url === "/api/ssh/grants").length).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
