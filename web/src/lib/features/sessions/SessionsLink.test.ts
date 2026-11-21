// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostInfo } from "../hosts";
import Harness from "./SessionsLinkHarness.svelte";

const connect = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock("../../realtime/sessions", () => ({ connectSessions: connect }));

const realFetch = globalThis.fetch;
let urls: string[] = [];
beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    "fetch",
    async (url: RequestInfo | URL) => (
      urls.push(String(url)),
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    ),
  );
});
const open: Array<() => void> = [];
afterEach(() => {
  for (const url of open.splice(0)) url();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  connect.mockClear();
});

function show(hosts: HostInfo[] | undefined, host = "nas") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (hosts) client.setQueryData(["hosts"], hosts);
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(Harness, { target, props: { client, host, instance: "i1" } });
  open.push(() => unmount(item));
  flushSync();
  return target;
}

const link = (item: HTMLElement) => item.querySelector('a[title="Sessions"]');

test("SessionsLink is hidden for a host with sessions false and shown with no host data", () => {
  expect(link(show([{ id: "nas", name: "NAS", status: "ok", sessions: false }]))).toBeNull();
  expect(link(show(undefined))!.getAttribute("href")).toBe("/sessions?host=nas&instance=i1");
  expect(link(show([{ id: "nas", name: "NAS", status: "ok", sessions: true }]))).not.toBeNull();
  expect(link(show([{ id: "nas", name: "NAS", status: "ok" }]))).not.toBeNull();
  // Another host without sessions does not hide the link of this one.
  expect(link(show([{ id: "pi", name: "PI", status: "ok", sessions: false }]))).not.toBeNull();
});

test("SessionsLink opens no stream and makes no sessions request", async () => {
  show(undefined);
  show([{ id: "nas", name: "NAS", status: "ok", sessions: true }]);
  await Promise.resolve();
  await new Promise<void>((row) => queueMicrotask(row));
  expect(connect).not.toHaveBeenCalled();
  expect(urls).toEqual([]);
});
