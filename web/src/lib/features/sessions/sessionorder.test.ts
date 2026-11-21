import { expect, test } from "vitest";
import type { GlobalSession } from "./api";
import { sessionKey, sortSessions } from "./sessionorder";

const mk = (id: string, over: Partial<GlobalSession> = {}, host = "local"): GlobalSession => ({
  id,
  root: "/r",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  instance: { id: "0123456789ab", name: "i", path: "/p", state: "active" },
  host: { id: host, name: host },
  ...over,
});

test("busy live sessions come first, then idle live, then the others by lastActiveAt newest first", () => {
  const rows = [
    mk("old", { lastActiveAt: "2026-01-01T00:00:00.000Z" }),
    mk("new", { lastActiveAt: "2026-03-01T00:00:00.000Z" }),
    mk("idle", { live: { status: "idle", remoteControl: false }, lastActiveAt: "2026-01-01T00:00:00.000Z" }),
    mk("busy", { live: { status: "busy", remoteControl: false }, lastActiveAt: "2025-01-01T00:00:00.000Z" }),
    mk("nostatus", { live: { remoteControl: true }, lastActiveAt: "2026-02-01T00:00:00.000Z" }),
  ];
  expect(sortSessions(rows).map((text) => text.id)).toEqual(["busy", "nostatus", "idle", "new", "old"]);
});

test("equal times keep a stable order by id", () => {
  const rows = [mk("b"), mk("a"), mk("c")];
  expect(sortSessions(rows).map((text) => text.id)).toEqual(["a", "b", "c"]);
});

test("the input array is not changed", () => {
  const rows = [mk("b"), mk("a")];
  sortSessions(rows);
  expect(rows.map((text) => text.id)).toEqual(["b", "a"]);
});

test("sessionKey differs for the same session id on two hosts", () => {
  expect(sessionKey(mk("x", {}, "a"))).not.toBe(sessionKey(mk("x", {}, "b")));
});
