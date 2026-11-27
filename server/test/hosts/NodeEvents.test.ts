import { describe, expect, test } from "bun:test";
import { NodeEvents } from "../../src/hosts/NodeEvents";
import type { NodeEvent } from "../../src/hosts/NodeEvents";

const fixed = () => new Date("2026-11-10T10:00:00.000Z");

describe("NodeEvents", () => {
  test("hooks reach every subscriber in order", () => {
    const ev = new NodeEvents({ now: fixed });
    const nodeEvents: NodeEvent[] = [];
    const item: NodeEvent[] = [];
    ev.subscribe((nodeEvent) => nodeEvents.push(nodeEvent));
    ev.subscribe((nodeEvent) => item.push(nodeEvent));
    const required = ev.hooks();
    required.onStep({ step: "downloading", to: "1.2.3" });
    required.onLog("hello");
    required.onStep({ step: "verifying" });
    const want: NodeEvent[] = [
      { type: "step", step: "downloading", to: "1.2.3" },
      { type: "log", line: "hello", at: "2026-11-10T10:00:00.000Z" },
      { type: "step", step: "verifying" },
    ];
    expect(nodeEvents).toEqual(want);
    expect(item).toEqual(want);
  });

  test("lines keeps only the last maxLines", () => {
    const ev = new NodeEvents({ now: fixed, maxLines: 3 });
    for (const item of ["1", "2", "3", "4"]) ev.hooks().onLog(item);
    expect(ev.lines().map((line) => line.line)).toEqual(["2", "3", "4"]);
  });

  test("lines defaults to 200", () => {
    const ev = new NodeEvents({ now: fixed });
    for (let index = 0; index < 250; index++) ev.hooks().onLog(String(index));
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
    expect(ev.lines().map((line) => line.line)).toEqual(["new"]);
  });

  test("unsubscribed listener gets nothing", () => {
    const ev = new NodeEvents({ now: fixed });
    const got: NodeEvent[] = [];
    const off = ev.subscribe((nodeEvent) => got.push(nodeEvent));
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
    ev.subscribe((nodeEvent) => got.push(nodeEvent));
    expect(() => {
      ev.hooks().onLog("a");
    }).not.toThrow();
    expect(got).toHaveLength(1);
  });

  const payload = { scannedAt: "t", available: true, sessions: [] };

  test("a sessions event is kept as the latest and given to subscribers", () => {
    const ev = new NodeEvents({ now: fixed });
    const got: NodeEvent[] = [];
    ev.subscribe((e) => got.push(e));
    ev.emit({ type: "sessions", ...payload });
    expect(got).toEqual([{ type: "sessions", ...payload }]);
    expect(ev.latestSessions()).toEqual(payload);
  });

  test("latestSessions is null before the first sessions event", () => {
    expect(new NodeEvents().latestSessions()).toBeNull();
  });

  test("a sessions event does not touch the update step or the lines", () => {
    const ev = new NodeEvents({ now: fixed });
    ev.emit({ type: "step", step: "downloading", to: "1.0.0" });
    ev.emit({ type: "log", line: "a", at: "t" });
    const step = ev.snapshotUpdate();
    ev.emit({ type: "sessions", ...payload });
    expect(ev.snapshotUpdate()).toEqual(step);
    expect(ev.lines()).toEqual([{ line: "a", at: "t" }]);
  });
});
