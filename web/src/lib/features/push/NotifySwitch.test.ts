// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import NotifySwitch from "./NotifySwitch.svelte";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let hubFails: boolean;
let permission: NotificationPermission;
let existing: { endpoint: string; toJSON: () => unknown; unsubscribe: ReturnType<typeof vi.fn> } | null;
let pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
const open: Array<() => void> = [];
const KEY = "AQID"; // bytes 1, 2, 3

function fakeSub(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "a", auth: "b" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

beforeEach(() => {
  calls = [];
  hubFails = false;
  permission = "default";
  existing = null;
  pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async () => fakeSub("https://push.example/1")),
  };
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission: vi.fn(async () => {
      permission = "granted";
      return permission;
    }),
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({
      method: init?.method ?? "GET",
      url: path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (hubFails && path !== "/api/push/key")
      return new Response(JSON.stringify({ error: "the hub refused" }), { status: 500 });
    if (path === "/api/push/key") return new Response(JSON.stringify({ key: KEY }), { status: 200 });
    return new Response(null, { status: 204 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

async function show() {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(NotifySwitch, { target });
  open.push(() => unmount(mounted));
  flushSync();
  await vi.waitFor(() => expect(target.textContent).not.toBe(""));
  return target;
}

const toggle = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[role="switch"]')!;

test("NotifySwitch is hidden without PushManager", async () => {
  vi.stubGlobal("PushManager", undefined);
  Reflect.deleteProperty(globalThis, "PushManager");
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(NotifySwitch, { target });
  open.push(() => unmount(mounted));
  flushSync();
  await Promise.resolve();
  expect(target.textContent?.trim()).toBe("");
  expect(target.querySelector("input")).toBeNull();
});

test("NotifySwitch is off when permission is denied and says how to allow it", async () => {
  permission = "denied";
  const target = await show();
  expect(toggle(target).disabled).toBe(true);
  expect(toggle(target).checked).toBe(false);
  expect(target.textContent?.replace(/\s+/g, " ")).toContain("browser settings");
});

test("turning on asks permission, subscribes with the hub key and posts the subscription", async () => {
  const target = await show();
  expect(target.textContent).toContain("Notify this device");
  toggle(target).click();
  await vi.waitFor(() => expect(calls.some((call) => call.url === "/api/push/subscribe")).toBe(true));
  expect(pushManager.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2, 3]),
  });
  const post = calls.find((call) => call.url === "/api/push/subscribe")!;
  expect(post.method).toBe("POST");
  expect(post.body).toEqual({ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } });
  await vi.waitFor(() => expect(toggle(target).checked).toBe(true));
});

test("turning off unsubscribes the browser and calls the hub", async () => {
  permission = "granted";
  existing = fakeSub("https://push.example/1");
  const target = await show();
  await vi.waitFor(() => expect(toggle(target).checked).toBe(true));
  toggle(target).click();
  await vi.waitFor(() => expect(existing!.unsubscribe).toHaveBeenCalled());
  await vi.waitFor(() => expect(calls.some((call) => call.url === "/api/push/unsubscribe")).toBe(true));
  expect(calls.find((call) => call.url === "/api/push/unsubscribe")!.body).toEqual({
    endpoint: "https://push.example/1",
  });
  await vi.waitFor(() => expect(toggle(target).checked).toBe(false));
});

test("NotifySwitch shows an error text when the hub refuses", async () => {
  hubFails = true;
  const target = await show();
  toggle(target).click();
  await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain("the hub refused"));
  expect(toggle(target).checked).toBe(false);
});
