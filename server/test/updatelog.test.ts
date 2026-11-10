import { describe, expect, test } from "bun:test";
import { UpdateLog } from "../src/updatelog";

describe("UpdateLog", () => {
  test("keeps the last 200 lines for each host", () => {
    const log = new UpdateLog();
    for (let i = 0; i < 250; i++) log.add("nas", `l${i}`);
    log.add("pi", "x");
    const got = log.get("nas");
    expect(got.length).toBe(200);
    expect(got[0]!.line).toBe("l50");
    expect(got[199]!.line).toBe("l249");
    expect(log.get("pi").map((l) => l.line)).toEqual(["x"]);
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
    expect(log.all().pi!.map((l) => l.line)).toEqual(["b"]);
  });

  test("get and all return copies", () => {
    const log = new UpdateLog();
    log.add("nas", "a");
    log.get("nas").push({ line: "evil", at: "" });
    log.all().nas!.length = 0;
    expect(log.get("nas").length).toBe(1);
  });

  test("onLine listeners get each line, an unsubscribed one gets nothing, a throwing one does not stop the others", () => {
    const log = new UpdateLog({ now: () => new Date("2026-11-10T10:00:00.000Z") });
    const a: string[] = [];
    const b: string[] = [];
    log.onLine(() => {
      throw new Error("bad listener");
    });
    const offA = log.onLine((e) => a.push(`${e.host}:${e.line}:${e.at}`));
    log.onLine((e) => b.push(e.line));
    log.add("nas", "one");
    offA();
    log.add("nas", "two");
    expect(a).toEqual(["nas:one:2026-11-10T10:00:00.000Z"]);
    expect(b).toEqual(["one", "two"]);
  });

  test("add takes an optional time that replaces now", () => {
    const log = new UpdateLog({ now: () => new Date("2026-11-10T10:00:00.000Z") });
    const seen: string[] = [];
    log.onLine((e) => seen.push(e.at));
    log.add("nas", "a", "2026-01-01T00:00:00.000Z");
    expect(log.get("nas")[0]!.at).toBe("2026-01-01T00:00:00.000Z");
    expect(seen).toEqual(["2026-01-01T00:00:00.000Z"]);
  });
});
