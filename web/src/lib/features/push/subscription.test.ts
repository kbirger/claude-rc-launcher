import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { inRoot } from "../../../../test/effect-root.svelte";
import { ApiError } from "../../shared/http";
import { createPushSubscriptionModel, keyBytes, pushSupported } from "./subscription.svelte";

let permission: NotificationPermission;
let existing: { endpoint: string; toJSON: () => unknown; unsubscribe: ReturnType<typeof vi.fn> } | null;
let pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
let api: {
  getKey: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const fakeSub = (endpoint: string) => ({
  endpoint,
  toJSON: () => ({ endpoint }),
  unsubscribe: vi.fn(async () => true),
});

beforeEach(() => {
  permission = "default";
  existing = null;
  pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async () => fakeSub("https://push.example/1")),
  };
  api = {
    getKey: vi.fn(async () => ({ key: "-_8" })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
  };
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission: vi.fn(async () => permission),
  });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
});
afterEach(() => vi.unstubAllGlobals());

const mount = () => inRoot(() => createPushSubscriptionModel(api));

describe("push helpers", () => {
  test("keyBytes decodes base64url", () => {
    expect([...keyBytes("-_8")]).toEqual([251, 255]);
  });

  test("push needs a service worker, PushManager and Notification", () => {
    expect(pushSupported()).toBe(true);
    vi.stubGlobal("PushManager", undefined);
    expect(pushSupported()).toBe(false);
  });
});

describe("push subscription model", () => {
  test("sync reads the subscription and registers it again when the permission is granted", async () => {
    permission = "granted";
    existing = fakeSub("https://push.example/old");
    const { value: model, dispose } = mount();
    await model.sync();
    expect(model.on).toBe(true);
    expect(api.subscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/old" });
    dispose();
  });

  test("a denied permission reads as off and denied", async () => {
    permission = "denied";
    existing = fakeSub("https://push.example/old");
    const { value: model, dispose } = mount();
    await model.sync();
    expect(model.denied).toBe(true);
    expect(model.on).toBe(false);
    expect(api.subscribe).not.toHaveBeenCalled();
    dispose();
  });

  test("turning on asks the permission, subscribes with the key bytes and posts the subscription", async () => {
    permission = "granted";
    const { value: model, dispose } = mount();
    expect(await model.change(true)).toBe(true);
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([251, 255]),
    });
    expect(api.subscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/1" });
    expect(model.busy).toBe(false);
    dispose();
  });

  test("a refused permission stays off with a message", async () => {
    permission = "denied";
    const { value: model, dispose } = mount();
    expect(await model.change(true)).toBe(false);
    expect(model.problem).toBe("Notifications are not allowed for this site.");
    expect(model.denied).toBe(true);
    dispose();
  });

  test("a hub that refuses the subscription makes the browser drop it", async () => {
    permission = "granted";
    const made = fakeSub("https://push.example/1");
    pushManager.subscribe.mockResolvedValue(made);
    api.subscribe.mockRejectedValue(new Error("the hub refused"));
    const { value: model, dispose } = mount();
    expect(await model.change(true)).toBe(false);
    expect(made.unsubscribe).toHaveBeenCalled();
    expect(model.problem).toBe("the hub refused");
    dispose();
  });

  test("turning off tells the hub first, and a 404 of the hub still ends the subscription", async () => {
    permission = "granted";
    existing = fakeSub("https://push.example/old");
    api.unsubscribe.mockRejectedValue(new ApiError(404, "not found"));
    const { value: model, dispose } = mount();
    await model.sync();
    expect(await model.change(false)).toBe(false);
    expect(api.unsubscribe).toHaveBeenCalledWith("https://push.example/old");
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(model.problem).toBe("");
    dispose();
  });

  test("a hub that fails the turn off keeps the browser subscription and the switch on", async () => {
    permission = "granted";
    existing = fakeSub("https://push.example/old");
    api.unsubscribe.mockRejectedValue(new ApiError(500, "down"));
    const { value: model, dispose } = mount();
    await model.sync();
    expect(await model.change(false)).toBe(true);
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(model.problem).toBe("down");
    dispose();
  });
});
