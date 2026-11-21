import { expect, test } from "vitest";
import { listHosts } from "./api";
import { useFetchStub } from "../../../../test/fetch-stub";

const { calls, stub } = useFetchStub();

test("listHosts calls /api/hosts", async () => {
  stub(200, [{ id: "local", name: "box", status: "ok" }]);
  expect(await listHosts()).toEqual([{ id: "local", name: "box", status: "ok" }]);
  expect(calls[0]!.url).toBe("/api/hosts");
});
