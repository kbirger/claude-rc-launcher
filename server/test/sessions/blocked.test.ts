import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blockedIn, classifyDenial } from "../../src/sessions/blocked";
import type { BlockReason } from "../../src/sessions/blocked";
import type { TranscriptFs } from "../../src/sessions/transcriptfs";

const fixture = (name: string): string[] =>
  readFileSync(join(import.meta.dir, "fixtures", "blocked", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);

function fsOf(lines: string[]): TranscriptFs {
  return {
    readdir: () => Promise.resolve([]),
    stat: () => Promise.resolve({ mtimeMs: 0 }),
    lines: async function* () {
      for (const line of lines) yield line;
    },
  };
}

const use = (id: string, name: string, input: object, at = "2026-11-14T10:00:00.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: unknown, isError: boolean | "absent" = true) =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-11-14T10:00:01.000Z",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content: text, ...(isError === "absent" ? {} : { is_error: isError }) },
      ],
    },
  });
const run = (lines: string[], max?: number) => blockedIn({ fs: fsOf(lines), file: "x.jsonl", ...(max ? { max } : {}) });

describe("classifyDenial", () => {
  const reasons: BlockReason[] = ["needs_approval", "user_rejected", "classifier", "deny_rule", "safety_check"];

  for (const reason of reasons) {
    test(`the ${reason} fixture text gives ${reason}`, () => {
      const rec = JSON.parse(fixture(reason)[1]);
      expect(classifyDenial(rec.message.content[0].content)).toBe(reason);
    });
  }

  test("a classifier that gave no verdict is a classifier block", () => {
    expect(
      classifyDenial(
        "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash",
      ),
    ).toBe("classifier");
  });
  test("don't ask mode is a needs_approval block", () => {
    expect(
      classifyDenial("Permission to use Bash has been denied because Claude Code is running in don't ask mode."),
    ).toBe("needs_approval");
  });
  test("an ordinary failure and an empty text are not denials", () => {
    expect(classifyDenial("Exit code 1")).toBeUndefined();
    expect(classifyDenial("")).toBeUndefined();
    expect(
      classifyDenial("<tool_use_error>Blocked: sleep 90 followed by: gh run list</tool_use_error>"),
    ).toBeUndefined();
  });
});

describe("blockedIn", () => {
  test("a denied call gives one BlockedCall with the tool, the input, the time of the call and the reason", async () => {
    const out = await run(fixture("needs_approval"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "toolu_needs_approval",
      at: "2026-11-14T10:00:00.000Z",
      tool: "Bash",
      input: { command: "touch /work/marker1" },
      reason: "needs_approval",
    });
    expect(out[0].text).toContain("needs approval");
  });

  test("the result text can be a list of text blocks", async () => {
    const out = await run([
      use("t1", "Bash", { command: "x" }),
      result("t1", [
        { type: "text", text: "Permission for this action was denied by the Claude Code auto mode classifier." },
      ]),
    ]);
    expect(out.map((blockedCall) => blockedCall.reason)).toEqual(["classifier"]);
  });

  test("an error with no denial text gives nothing", async () => {
    expect(await run([use("t1", "Bash", { command: "false" }), result("t1", "Exit code 1")])).toEqual([]);
  });

  test("a result without is_error true gives nothing", async () => {
    const text = "touch in '/x' needs approval.";
    expect(await run([use("t1", "Bash", {}), result("t1", text, false)])).toEqual([]);
    expect(await run([use("t2", "Bash", {}), result("t2", text, "absent")])).toEqual([]);
  });

  test("a result before its use gives nothing", async () => {
    expect(await run([result("t1", "x needs approval."), use("t1", "Bash", {})])).toEqual([]);
  });

  test("a repeated tool_use id gives one entry", async () => {
    const out = await run([
      use("t1", "Bash", { command: "a" }),
      use("t1", "Bash", { command: "a" }),
      result("t1", "a needs approval."),
    ]);
    expect(out).toHaveLength(1);
  });

  test("the same id with another tool name gives nothing (fail closed)", async () => {
    expect(await run([use("t1", "Bash", {}), use("t1", "Edit", {}), result("t1", "x needs approval.")])).toEqual([]);
  });

  test("a line over 1 MB and a half-written last line do not stop the scan", async () => {
    const big = "x".repeat(2_000_000);
    const out = await run([
      big,
      use("t1", "Bash", { command: "a" }),
      result("t1", "a needs approval."),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2"',
    ]);
    expect(out.map((blockedCall) => blockedCall.id)).toEqual(["t1"]);
  });

  test("results are newest first and capped at max", async () => {
    const lines: string[] = [];
    for (let index = 1; index <= 5; index++)
      lines.push(
        use(`t${index}`, "Bash", { command: `c${index}` }, `2026-11-14T10:00:0${index}.000Z`),
        result(`t${index}`, `c${index} needs approval.`),
      );
    const out = await run(lines, 3);
    expect(out.map((blockedCall) => blockedCall.id)).toEqual(["t5", "t4", "t3"]);
  });

  test("a tool_use without an object input still lists with an empty input", async () => {
    const out = await run([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
      result("t1", "x needs approval."),
    ]);
    expect(out[0]).toMatchObject({ tool: "Bash", input: {} });
  });
});
