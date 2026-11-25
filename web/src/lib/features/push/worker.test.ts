import { expect, test, vi } from "vitest";
import { handleClick, notificationOptions, parsePush } from "./worker";

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
