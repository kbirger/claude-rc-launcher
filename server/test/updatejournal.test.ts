import { describe, expect, test } from "bun:test";
import { journalText, updateJournal } from "../src/updatejournal";
import type { UpdateEntry } from "../src/updaterecord";

const e = (o: Partial<UpdateEntry> = {}): UpdateEntry => ({ host: "aihub", startedAt: "t1", startedBy: "kir", from: "0.10.0", status: "running", ...o });

describe("updateJournal", () => {
  test("logs the start, each new step and the result once", () => {
    const lines: string[] = [];
    const j = updateJournal((l) => lines.push(l));
    j(e());
    j(e({ step: "downloading" }));
    j(e({ step: "downloading" }));
    j(e({ step: "installing-client", stepDetail: "/usr/local/bin/claude-rc" }));
    j(e({ status: "updated", to: "0.10.1" }));
    j(e({ status: "updated", to: "0.10.1" }));
    expect(lines).toEqual([
      "[update] aihub started by kir from 0.10.0",
      "[update] aihub step downloading",
      "[update] aihub step installing-client: /usr/local/bin/claude-rc",
      "[update] aihub updated (0.10.1)",
    ]);
  });
  test("a new run of the same host logs its start again", () => {
    const lines: string[] = [];
    const j = updateJournal((l) => lines.push(l));
    j(e({ status: "failed", error: "boom" }));
    j(e({ startedAt: "t2" }));
    expect(lines).toEqual(["[update] aihub failed: boom", "[update] aihub started by kir from 0.10.0"]);
  });
  test("levels follow the result", () => {
    const levels: string[] = [];
    const j = updateJournal((_l, lv) => levels.push(lv));
    j(e({ status: "failed", error: "x" }));
    j(e({ host: "b", status: "rolled back" }));
    j(e({ host: "c", status: "updated" }));
    expect(levels).toEqual(["error", "warn", "log"]);
  });
  test("untrusted text loses control characters and is cut", () => {
    expect(journalText("a\r\nb\u001b[31m")).toBe("a b [31m");
    expect(journalText("x".repeat(300)).length).toBe(200);
  });
});
