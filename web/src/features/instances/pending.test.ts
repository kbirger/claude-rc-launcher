import { expect, test } from "bun:test";
import type { Instance } from "./api";
import { mergePending, startRowName } from "./pending";

const inst = (id: string, path = `/p/${id}`): Instance => ({ id, path, name: id, state: "active", startedAt: null });

test("startRowName", () => {
  expect(startRowName({ path: "/home/me/docs/" })).toBe("docs");
  expect(startRowName({ path: "C:\\a\\b" })).toBe("b");
  expect(startRowName({ path: "/x", name: "mine" })).toBe("mine");
  expect(startRowName({ path: "/" })).toBe("/");
});

test("mergePending", () => {
  const list = [inst("a"), inst("b")];
  const withStart = mergePending(list, [{ path: "/new/dir" }], []);
  expect(withStart).toHaveLength(3);
  expect(withStart[0]).toMatchObject({ name: "dir", pending: "starting" });
  expect(withStart[0].instance).toBeUndefined();

  const stopping = mergePending(list, [], [{ id: "b", kind: "stopping" }]);
  expect(stopping.map((r) => r.pending)).toEqual([undefined, "stopping"]);
  expect(stopping[1].instance).toBe(list[1]);

  expect(mergePending(list, [], []).every((r) => r.pending === undefined)).toBe(true);
  expect(mergePending(list, [{ path: "/p/a" }], [])).toHaveLength(2);
});
