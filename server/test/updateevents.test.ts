import { describe, expect, test } from "bun:test";
import { type NodeEvent, NodeEvents } from "../src/updateevents";

const fixed = () => new Date("2026-11-10T10:00:00.000Z");

describe("NodeEvents", () => {
  test("hooks reach every subscriber in order", () => {
    const ev = new NodeEvents({ now: fixed });
    const a: NodeEvent[] = [];
    const b: NodeEvent[] = [];
    ev.subscribe((e) => a.push(e));
    ev.subscribe((e) => b.push(e));
    const h = ev.hooks();
    h.onStep({ step: "downloading", to: "1.2.3" });
    h.onLog("hello");
    h.onStep({ step: "verifying" });
    const want: NodeEvent[] = [
      { type: "step", step: "downloading", to: "1.2.3" },
      { type: "log", line: "hello", at: "2026-11-10T10:00:00.000Z" },
      { type: "step", step: "verifying" },
    ];
    expect(a).toEqual(want);
    expect(b).toEqual(want);
  });

  test("lines keeps only the last maxLines", () => {
    const ev = new NodeEvents({ now: fixed, maxLines: 3 });
    for (const l of ["1", "2", "3", "4"]) ev.hooks().onLog(l);
    expect(ev.lines().map((x) => x.line)).toEqual(["2", "3", "4"]);
  });

  test("lines defaults to 200", () => {
    const ev = new NodeEvents({ now: fixed });
    for (let i = 0; i < 250; i++) ev.hooks().onLog(String(i));
    expect(ev.lines()).toHaveLength(200);
    expect(ev.lines()[0].line).toBe("50");
  });

  test("snapshotUpdate lifecycle", () => {
    const ev = new NodeEvents({ now: fixed });
    expect(ev.snapshotUpdate()).toBeNull();
    ev.hooks().onStep({ step: "downloading", to: "1.2.3" });
    expect(ev.snapshotUpdate()).toEqual({ step: "downloading", to: "1.2.3", startedAt: "2026-11-10T10:00:00.000Z" });
    ev.hooks().onStep({ step: "verifying" });
    expect(ev.snapshotUpdate()).toEqual({ step: "verifying", to: "1.2.3", startedAt: "2026-11-10T10:00:00.000Z" });
    ev.hooks().onStep({ step: "up-to-date" });
    expect(ev.snapshotUpdate()).toBeNull();
    ev.hooks().onStep({ step: "downloading", to: "1.2.4" });
    ev.hooks().onStep({ step: "failed", detail: "boom" });
    expect(ev.snapshotUpdate()).toBeNull();
  });

  test("restarting stays in the snapshot", () => {
    const ev = new NodeEvents({ now: fixed });
    ev.hooks().onStep({ step: "downloading", to: "1.2.3" });
    ev.hooks().onStep({ step: "restarting" });
    expect(ev.snapshotUpdate()?.step).toBe("restarting");
  });

  test("downloading clears the lines of the previous update", () => {
    const ev = new NodeEvents({ now: fixed });
    ev.hooks().onStep({ step: "downloading", to: "1" });
    ev.hooks().onLog("old");
    ev.hooks().onStep({ step: "failed" });
    expect(ev.lines()).toHaveLength(1);
    ev.hooks().onStep({ step: "downloading", to: "2" });
    expect(ev.lines()).toEqual([]);
    ev.hooks().onLog("new");
    expect(ev.lines().map((x) => x.line)).toEqual(["new"]);
  });

  test("unsubscribed listener gets nothing", () => {
    const ev = new NodeEvents({ now: fixed });
    const got: NodeEvent[] = [];
    const off = ev.subscribe((e) => got.push(e));
    ev.hooks().onLog("a");
    off();
    ev.hooks().onLog("b");
    expect(got).toHaveLength(1);
  });

  test("a throwing subscriber does not stop the others", () => {
    const ev = new NodeEvents({ now: fixed });
    const got: NodeEvent[] = [];
    ev.subscribe(() => {
      throw new Error("bad");
    });
    ev.subscribe((e) => got.push(e));
    expect(() => ev.hooks().onLog("a")).not.toThrow();
    expect(got).toHaveLength(1);
  });
});
