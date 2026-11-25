import { expect, test, vi } from "vitest";
import { handleClick, notificationOptions, parsePush, safeUrl, showPush } from "./worker";

const message = { title: "SSH", body: "Node wants access", url: "/ssh", tag: "ssh-g1", grantId: "g1" };

test("parsePush returns undefined for bad JSON", () => {
  expect(parsePush("not json")).toBeUndefined();
  expect(parsePush("[1]")).toBeUndefined();
  expect(parsePush('{"title":"x"}')).toBeUndefined();
  expect(parsePush(JSON.stringify(message))).toEqual(message);
});

test("options carry tag and two actions only with a grant id", () => {
  const withGrant = notificationOptions(message);
  expect(withGrant.tag).toBe("ssh-g1");
  expect(withGrant.body).toBe("Node wants access");
  expect(withGrant.icon).toBe("/icon-192.png");
  expect(withGrant.data).toEqual({ url: "/ssh", grantId: "g1" });
  expect(withGrant.actions).toEqual([
    { action: "open", title: "Open" },
    { action: "deny", title: "Deny" },
  ]);
  const without = notificationOptions({ ...message, grantId: undefined });
  expect(without.actions).toBeUndefined();
});

const deps = (deny: (id: string) => Promise<Response>) => ({ deny: vi.fn(deny), open: vi.fn(async () => {}) });

test("deny action calls deny and does not open", async () => {
  const fake = deps(async () => new Response("{}", { status: 200 }));
  await handleClick("deny", { url: "/ssh", grantId: "g1" }, fake);
  expect(fake.deny).toHaveBeenCalledWith("g1");
  expect(fake.open).not.toHaveBeenCalled();
});

test("a 409 from deny opens /ssh", async () => {
  const fake = deps(async () => new Response("{}", { status: 409 }));
  await handleClick("deny", { url: "/ssh", grantId: "g1" }, fake);
  expect(fake.open).toHaveBeenCalledWith("/ssh");
});

test("a thrown deny opens /ssh", async () => {
  const fake = deps(async () => {
    throw new Error("offline");
  });
  await handleClick("deny", { url: "/ssh", grantId: "g1" }, fake);
  expect(fake.open).toHaveBeenCalledWith("/ssh");
});

test("no action opens the url", async () => {
  const fake = deps(async () => new Response("{}"));
  await handleClick("", { url: "/ssh", grantId: "g1" }, fake);
  await handleClick("open", { url: "/ssh" }, fake);
  expect(fake.open).toHaveBeenCalledTimes(2);
  expect(fake.deny).not.toHaveBeenCalled();
});

test("safeUrl keeps a path of this site and replaces anything else with /ssh", () => {
  expect(safeUrl("/ssh")).toBe("/ssh");
  expect(safeUrl("/ssh?target=a")).toBe("/ssh?target=a");
  expect(safeUrl("https://evil.example")).toBe("/ssh");
  expect(safeUrl("//evil.example")).toBe("/ssh");
  expect(safeUrl("/\\evil.example")).toBe("/ssh");
  expect(safeUrl("javascript:alert(1)")).toBe("/ssh");
  expect(safeUrl(undefined)).toBe("/ssh");
});

test("a bad url in a push or in click data never reaches open", async () => {
  expect(parsePush(JSON.stringify({ ...message, url: "https://evil.example" }))?.url).toBe("/ssh");
  expect(notificationOptions({ ...message, url: "//evil.example" }).data).toEqual({ url: "/ssh", grantId: "g1" });
  const fake = deps(async () => new Response("{}"));
  await handleClick("open", { url: "https://evil.example" }, fake);
  expect(fake.open).toHaveBeenCalledWith("/ssh");
});

test("a close message shows a notification with the same tag and closes it and the earlier one", async () => {
  const order: string[] = [];
  const earlier = { close: vi.fn(() => order.push("close-earlier")) };
  const fresh = { close: vi.fn(() => order.push("close-new")) };
  const registration = {
    showNotification: vi.fn(async (_title: string, _options?: NotificationOptions) => {
      order.push("show");
    }),
    getNotifications: vi.fn(async (_filter?: { tag?: string }) => [earlier, fresh]),
  };

  await showPush({ title: "SSH request answered", body: "", url: "/ssh", tag: "ssh-g1", grantId: "g1", close: true }, registration);

  expect(registration.showNotification).toHaveBeenCalledTimes(1);
  expect(registration.showNotification.mock.calls[0]![1]).toMatchObject({ tag: "ssh-g1" });
  expect(registration.getNotifications).toHaveBeenCalledWith({ tag: "ssh-g1" });
  expect(order).toEqual(["show", "close-earlier", "close-new"]);
});

test("a normal message only shows and closes nothing", async () => {
  const registration = { showNotification: vi.fn(async () => {}), getNotifications: vi.fn(async () => []) };
  await showPush(message, registration);
  expect(registration.showNotification).toHaveBeenCalledWith("SSH", expect.objectContaining({ tag: "ssh-g1" }));
  expect(registration.getNotifications).not.toHaveBeenCalled();
});
