import { describe, expect, test } from "bun:test";
import { journalText, updateJournal } from "../../src/updates/journal";
import type { UpdateEntry } from "../../src/updates/UpdateRecord";

const helper = (item: Partial<UpdateEntry> = {}): UpdateEntry => ({
  host: "aihub",
  startedAt: "t1",
  startedBy: "kir",
  from: "0.10.0",
  status: "running",
  ...item,
});

describe("updateJournal", () => {
  test("logs the start, each new step and the result once", () => {
    const lines: string[] = [];
    const item = updateJournal((line) => lines.push(line));
    item(helper());
    item(helper({ step: "downloading" }));
    item(helper({ step: "downloading" }));
    item(helper({ step: "installing-client", stepDetail: "/usr/local/bin/claude-rc" }));
    item(helper({ status: "updated", to: "0.10.1" }));
    item(helper({ status: "updated", to: "0.10.1" }));
    expect(lines).toEqual([
      "[update] aihub started by kir from 0.10.0",
      "[update] aihub step downloading",
      "[update] aihub step installing-client: /usr/local/bin/claude-rc",
      "[update] aihub updated (0.10.1)",
    ]);
  });
  test("a new run of the same host logs its start again", () => {
    const lines: string[] = [];
    const item = updateJournal((line) => lines.push(line));
    item(helper({ status: "failed", error: "boom" }));
    item(helper({ startedAt: "t2" }));
    expect(lines).toEqual(["[update] aihub failed: boom", "[update] aihub started by kir from 0.10.0"]);
  });
  test("levels follow the result", () => {
    const levels: string[] = [];
    const item = updateJournal((_l, lv) => levels.push(lv));
    item(helper({ status: "failed", error: "x" }));
    item(helper({ host: "b", status: "rolled back" }));
    item(helper({ host: "c", status: "updated" }));
    expect(levels).toEqual(["error", "warn", "log"]);
  });
  test("untrusted text loses control characters and is cut", () => {
    expect(journalText("a\r\nb\u001b[31m")).toBe("a b [31m");
    expect(journalText("x".repeat(300)).length).toBe(200);
  });
});
