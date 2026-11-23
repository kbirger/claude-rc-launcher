// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Target } from "./api";
import TargetListHarness from "./TargetListHarness.svelte";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let targets: Target[];
const open: Array<() => void> = [];

const target = (extra: Partial<Target> = {}): Target => ({
  id: "nas",
  address: "10.0.0.5",
  port: 22,
  account: "root",
  systemType: "synology",
  nodes: ["node1"],
  state: "ready",
  ...extra,
});

beforeEach(() => {
  calls = [];
  targets = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown = { ok: true };
    if (path === "/api/hosts") body = [{ id: "node1", name: "Garage", status: "ok" }];
    else if (path === "/api/ssh/targets" && method === "GET") body = targets;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

async function show(list: Target[]) {
  targets = list;
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = mount(TargetListHarness, { target: container, props: { client: createQueryClient() } });
  open.push(() => unmount(mounted));
  await vi.waitFor(() => expect(container.querySelectorAll("[data-target]").length).toBe(list.length));
  return container;
}

const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
const changes = () => calls.filter((call) => call.method !== "GET");

test("TargetList shows state, address, account and nodes", async () => {
  const shown = await show([target()]);
  const text = shown.textContent ?? "";
  expect(text).toContain("nas");
  expect(text).toContain("10.0.0.5:22");
  expect(text).toContain("root");
  expect(text).toContain("synology");
  expect(text).toContain("ready");
  await vi.waitFor(() => expect(shown.textContent).toContain("Garage (node1)"));
});

test("TargetList offers Disable for a ready target and Enable for a disabled one", async () => {
  const shown = await show([target(), target({ id: "pc", state: "disabled" })]);
  const [ready, disabled] = [...shown.querySelectorAll<HTMLElement>("[data-target]")];
  expect(button("Disable", ready)).toBeDefined();
  expect(button("Enable", ready)).toBeUndefined();
  expect(button("Enable", disabled)).toBeDefined();
  expect(button("Disable", disabled)).toBeUndefined();

  button("Disable", ready)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({ method: "PATCH", url: "/api/ssh/targets/nas", body: { state: "disabled" } });

  button("Enable", disabled)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(2));
  expect(changes()[1]).toMatchObject({ method: "PATCH", url: "/api/ssh/targets/pc", body: { state: "draft" } });
});

test("TargetList Retire asks for a confirmation and then calls DELETE", async () => {
  const shown = await show([target()]);
  button("Retire", shown)!.click();
  flushSync();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(changes()).toHaveLength(0);
  button("Cancel", dialog)!.click();
  flushSync();
  expect(changes()).toHaveLength(0);

  button("Retire", shown)!.click();
  const again = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find((item) =>
      button("Retire", item),
    );
    expect(found).toBeDefined();
    return found!;
  });
  button("Retire", again)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({ method: "DELETE", url: "/api/ssh/targets/nas" });
});

test("TargetList shows the line comment to remove for a retired target", async () => {
  const shown = await show([target({ state: "retired", account: "admin" })]);
  expect(shown.textContent).toContain(
    "Remove the line that ends with claude-rc:nas from the authorized_keys file of admin on 10.0.0.5.",
  );
  expect(button("Retire", shown)).toBeUndefined();
  expect(button("Disable", shown)).toBeUndefined();
});

test("TargetList links a draft target to the wizard with ?target=<id>", async () => {
  const shown = await show([target({ id: "box", state: "draft" })]);
  const link = [...shown.querySelectorAll<HTMLAnchorElement>("a")].find(
    (item) => item.textContent?.trim() === "Continue setup",
  );
  expect(link?.getAttribute("href")).toBe("/ssh?target=box");
});
