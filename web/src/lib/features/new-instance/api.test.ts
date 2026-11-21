import { expect, test } from "vitest";
import { browse, getNode, listUsers, mkdir } from "./api";
import { useFetchStub } from "../../../../test/fetch-stub";

const { calls, stub } = useFetchStub();

test("host ids are URL-encoded in every fs path", async () => {
  stub(200, {});
  await browse("a/b", "/x y");
  stub(201, {});
  await mkdir("a/b", "/p", "n");
  for (const call of calls) expect(call.url.startsWith("/api/hosts/a%2Fb/")).toBe(true);
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/fs?path=%2Fx%20y");
});

test("listUsers calls /users", async () => {
  stub(200, { selectable: true, default: "a", users: [{ name: "a" }] });
  const usersInfo = await listUsers("a/b");
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/users");
  expect(usersInfo.default).toBe("a");
});

test("browse adds the user query", async () => {
  stub(200, {});
  await browse("local", "/x", "al ice");
  await browse("local", undefined, "bob");
  await browse("local", "/x");
  expect(calls[0]!.url).toBe("/api/hosts/local/fs?path=%2Fx&user=al%20ice");
  expect(calls[1]!.url).toBe("/api/hosts/local/fs?user=bob");
  expect(calls[2]!.url).toBe("/api/hosts/local/fs?path=%2Fx");
});

test("mkdir sends user only when given", async () => {
  stub(201, { path: "/p/n" });
  await mkdir("local", "/p", "n", "alice");
  await mkdir("local", "/p", "n");
  await mkdir("local", "/p", "n", "");
  expect(calls[0]!.url).toBe("/api/hosts/local/fs/mkdir");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ parent: "/p", name: "n", user: "alice" });
  expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ parent: "/p", name: "n" });
  expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({ parent: "/p", name: "n" });
});

test("getNode GETs the node info", async () => {
  stub(200, { ok: true, clone: true });
  expect((await getNode("a b")).clone).toBe(true);
  expect(calls[0]!.url).toBe("/api/hosts/a%20b/node");
  expect(calls[0]!.init?.method).toBe("GET");
});
