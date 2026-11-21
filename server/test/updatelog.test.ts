import { describe, expect, test } from "bun:test";
import { UpdateLog } from "../src/updatelog";

describe("UpdateLog", () => {
  test("keeps the last 200 lines for each host", () => {
    const log = new UpdateLog();
    for (let index = 0; index < 250; index++) log.add("nas", `l${index}`);
    log.add("pi", "x");
    const got = log.get("nas");
    expect(got.length).toBe(200);
    expect(got[0].line).toBe("l50");
    expect(got[199].line).toBe("l249");
    expect(log.get("pi").map((logLine) => logLine.line)).toEqual(["x"]);
  });

  test("an `at` that is long or unreadable is replaced by the hub time; a short readable one is kept", () => {
    const log = new UpdateLog({ now: () => new Date("2026-11-10T10:00:00.000Z") });
    log.add("nas", "a", "x".repeat(1024 * 1024));
    log.add("nas", "b", "not a time");
    log.add("nas", "c", "2026-11-10T09:00:00.000Z");
    log.add("nas", "d", "2026-11-10T09:00:00.000Z" + " ".repeat(40));
    expect(log.get("nas").map((logLine) => logLine.at)).toEqual([
      "2026-11-10T10:00:00.000Z",
      "2026-11-10T10:00:00.000Z",
      "2026-11-10T09:00:00.000Z",
      "2026-11-10T10:00:00.000Z",
    ]);
  });

  test("a line is cut to 500 characters, stored and broadcast alike; exactly 500 is unchanged", () => {
    const log = new UpdateLog();
    const seen: string[] = [];
    log.onLine((event) => seen.push(event.line));
    log.add("nas", "x".repeat(1024 * 1024));
    log.add("nas", "y".repeat(500));
    const got = log.get("nas");
    expect(got[0].line).toHaveLength(500);
    expect(got[0].line.endsWith("...")).toBe(true);
    expect(got[0].line).toBe("x".repeat(497) + "...");
    expect(got[1].line).toBe("y".repeat(500));
    expect(seen[0]).toBe("x".repeat(497) + "...");
    expect(seen[1]).toBe("y".repeat(500));
  });

  test("maxLines is configurable and the time comes from now", () => {
    const log = new UpdateLog({ maxLines: 2, now: () => new Date("2026-11-10T10:00:00.000Z") });
    log.add("nas", "a");
    log.add("nas", "b");
    log.add("nas", "c");
    expect(log.get("nas")).toEqual([
      { line: "b", at: "2026-11-10T10:00:00.000Z" },
      { line: "c", at: "2026-11-10T10:00:00.000Z" },
    ]);
  });

  test("clear empties one host only, and all() lists the hosts with lines", () => {
    const log = new UpdateLog();
    log.add("nas", "a");
    log.add("pi", "b");
    log.clear("nas");
    expect(log.get("nas")).toEqual([]);
    expect(Object.keys(log.all())).toEqual(["pi"]);
    expect(log.all().pi.map((logLine) => logLine.line)).toEqual(["b"]);
  });

  test("get and all return copies", () => {
    const log = new UpdateLog();
    log.add("nas", "a");
    log.get("nas").push({ line: "evil", at: "" });
    log.all().nas.length = 0;
    expect(log.get("nas").length).toBe(1);
  });

  test("onLine listeners get each line, an unsubscribed one gets nothing, a throwing one does not stop the others", () => {
    const log = new UpdateLog({ now: () => new Date("2026-11-10T10:00:00.000Z") });
    const item: string[] = [];
    const entry: string[] = [];
    log.onLine(() => {
      throw new Error("bad listener");
    });
    const offA = log.onLine((event) => item.push(`${event.host}:${event.line}:${event.at}`));
    log.onLine((event) => entry.push(event.line));
    log.add("nas", "one");
    offA();
    log.add("nas", "two");
    expect(item).toEqual(["nas:one:2026-11-10T10:00:00.000Z"]);
    expect(entry).toEqual(["one", "two"]);
  });

  test("add takes an optional time that replaces now", () => {
    const log = new UpdateLog({ now: () => new Date("2026-11-10T10:00:00.000Z") });
    const seen: string[] = [];
    log.onLine((event) => seen.push(event.at));
    log.add("nas", "a", "2026-01-01T00:00:00.000Z");
    expect(log.get("nas")[0].at).toBe("2026-01-01T00:00:00.000Z");
    expect(seen).toEqual(["2026-01-01T00:00:00.000Z"]);
  });
});
