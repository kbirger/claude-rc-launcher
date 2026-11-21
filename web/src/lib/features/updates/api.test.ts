import { expect, test } from "vitest";
import { getLatest, getReleaseNotes, getUpdates, updateHost } from "./api";
import { useFetchStub } from "../../../../test/fetch-stub";

const { calls, stub } = useFetchStub();

test("updateHost sends an empty body without a release and only release with one", async () => {
  stub(202, { status: "restarting", from: "0.8.2" });
  await updateHost("n1");
  expect(calls[0]!.url).toBe("/api/hosts/n1/update");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({});
  await updateHost("n1", "0.8.3");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ release: "0.8.3" });
});

test("getLatest and getUpdates GET their endpoints", async () => {
  stub(200, { version: "0.8.3", checkedAt: "t" });
  await getLatest();
  stub(200, []);
  await getUpdates();
  expect(calls.map((call) => call.url)).toEqual(["/api/latest", "/api/updates"]);
});

test("getReleaseNotes GETs the range with encoded versions", async () => {
  stub(200, { releases: [], complete: true });
  await getReleaseNotes("0.22.0", "0.23.0+x y");
  expect(calls[0]!.url).toBe("/api/release-notes?from=0.22.0&to=0.23.0%2Bx%20y");
  expect(calls[0]!.init?.method).toBe("GET");
});
