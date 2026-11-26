// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Target } from "./api";
import TargetListHarness from "./TargetListHarness.svelte";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let targets: Target[];
let patchReply: unknown;
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
  patchReply = undefined;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown = { ok: true };
    if (path === "/api/ssh/status")
      body = {
        setUp: true,
        pendingRewrap: [],
        nodes: [
          { host: "node1", enabled: true, sourceAddress: "10.0.0.1" },
          { host: "node2", enabled: true, sourceAddress: "10.0.0.2" },
          { host: "node3", enabled: false, sourceAddress: "" },
        ],
      };
    else if (method === "PATCH" && path === "/api/ssh/targets/nas" && patchReply !== undefined) body = patchReply;
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
  expect(dialog.textContent).toContain("tries to remove the key line");
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

test("TargetList shows no retired entries and no text about them", async () => {
  const shown = await show([target({ account: "admin" })]);
  expect(shown.textContent).not.toContain("retired");
  expect(shown.textContent).not.toContain("claude-rc:");
  expect(shown.querySelector('[role="status"]')).toBeNull();
});

const retireWith = async (answer: Record<string, unknown>) => {
  const list = [target({ account: "admin" })];
  const shown = await show(list);
  const base = fetch;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      calls.push({ method: "DELETE", url: String(url), body: undefined });
      targets = [];
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }

    return base(url, init);
  });
  button("Retire", shown)!.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  button("Retire", dialog)!.click();
  const status = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="status"]');
    expect(found).not.toBeNull();
    return found!;
  });
  return { shown, status };
};

const answer = { id: "nas", account: "admin", address: "10.0.0.5", port: 22, systemType: "linux", managed: true };

test.each([
  ["removed", {}, "Retired nas. The key line was removed from admin@10.0.0.5."],
  ["not-found", {}, "Retired nas. The key line was not on admin@10.0.0.5."],
  [
    "failed",
    { detail: "connect refused" },
    "Retired nas. The hub could not remove the key line from admin@10.0.0.5: connect refused. You can remove the line that ends with claude-rc:nas yourself. It no longer works.",
  ],
  [
    "manual",
    { managed: false },
    "Retired nas. You can remove the line that ends with claude-rc:nas from the authorized_keys file of admin@10.0.0.5. It no longer works.",
  ],
])("TargetList shows a notice after a retire with the line %s", async (line, extra, text) => {
  const { shown, status } = await retireWith({ ...answer, line, ...extra });
  expect(status.textContent?.replace(/\s+/g, " ").trim()).toContain(text);
  await vi.waitFor(() => expect(shown.querySelectorAll("[data-target]")).toHaveLength(0));
  expect(shown.textContent).not.toContain("retired");
  // The notice can be dismissed.
  button("Dismiss", status)!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
});

test("TargetList links a draft target to the wizard with ?target=<id>", async () => {
  const shown = await show([target({ id: "box", state: "draft" })]);
  const link = [...shown.querySelectorAll<HTMLAnchorElement>("a")].find(
    (item) => item.textContent?.trim() === "Continue setup",
  );
  expect(link?.getAttribute("href")).toBe("/ssh?target=box");
});

const boxes = (within: ParentNode) => [...within.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

async function openEditor(list: Target[]) {
  const shown = await show(list);
  button("Edit nodes", shown)!.click();
  await vi.waitFor(() => expect(boxes(shown).length).toBeGreaterThan(0));
  return shown;
}

test("Edit nodes offers the nodes with access on, checks the current ones and saves the new list", async () => {
  patchReply = target({ nodes: ["node1", "node2"] });
  const shown = await openEditor([target()]);
  expect(boxes(shown).map((box) => [box.value, box.checked])).toEqual([
    ["node1", true],
    ["node2", false],
  ]);
  const save = button("Save", shown)!;
  expect(save.disabled).toBe(true);
  boxes(shown)[1]!.click();
  flushSync();
  expect(save.disabled).toBe(false);
  save.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({
    method: "PATCH",
    url: "/api/ssh/targets/nas",
    body: { nodes: ["node1", "node2"] },
  });
  await vi.waitFor(() => expect(shown.textContent).toContain("The nodes of nas are saved."));
  expect(shown.textContent).not.toContain("replace the old line");
});

test("a node with access off stays on the list so that it can be taken out", async () => {
  const shown = await openEditor([target({ nodes: ["node1", "node3"] })]);
  expect(boxes(shown).map((box) => [box.value, box.checked])).toEqual([
    ["node1", true],
    ["node2", false],
    ["node3", true],
  ]);
  expect(shown.textContent).toContain("(access is off)");
});

test("Save is off when no node is checked", async () => {
  const shown = await openEditor([target()]);
  boxes(shown)[0]!.click();
  flushSync();
  expect(button("Save", shown)!.disabled).toBe(true);
});

test("an external target shows the new key line after the save, with a Copy button", async () => {
  const line = 'from="10.0.0.1,10.0.0.2",restrict ssh-ed25519 AAAA claude-rc:nas';
  patchReply = { ...target({ nodes: ["node1", "node2"] }), installLine: line };
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const shown = await openEditor([target()]);
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain(line));
  expect(shown.textContent).toContain("replace the old line");
  button("Copy", shown)!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(line));
  button("Done", shown)!.click();
  await vi.waitFor(() => expect(button("Done", shown)).toBeUndefined());
});

test("a managed target says that the line on the machine was updated", async () => {
  patchReply = { ...target({ nodes: ["node1", "node2"], managedHost: "node2" }), lineUpdated: true };
  const shown = await openEditor([target({ managedHost: "node2" })]);
  expect(shown.textContent).toContain("The hub updates the key line on the machine");
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("The key line on the machine was updated."));
});

test("a refusal of the hub shows its text and keeps the form", async () => {
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PATCH")
      return new Response(JSON.stringify({ error: "the key line on the machine was not updated" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    const body =
      path === "/api/ssh/targets"
        ? [target()]
        : path === "/api/ssh/status"
          ? {
              setUp: true,
              pendingRewrap: [],
              nodes: [
                { host: "node1", enabled: true, sourceAddress: "a" },
                { host: "node2", enabled: true, sourceAddress: "b" },
              ],
            }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const shown = await openEditor([target()]);
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("the key line on the machine was not updated"));
  expect(button("Save", shown)).toBeDefined();
});
