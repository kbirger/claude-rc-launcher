// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultRunner, FORMAT_TIMEOUT_MS, runInProcess, type FormatJob } from "./formatrunner";

type Handler = ((e: { data: unknown }) => void) | null;
class FakeWorker {
  static instances: FakeWorker[] = [];
  static throwOnConstruct = false;
  static throwOnPost = false;
  onmessage: Handler = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = 0;
  posted: { id: number; job: FormatJob }[] = [];
  constructor(public url: unknown, public options: unknown) {
    if (FakeWorker.throwOnConstruct) throw new Error("no worker");
    FakeWorker.instances.push(this);
  }
  postMessage(m: { id: number; job: FormatJob }) {
    if (FakeWorker.throwOnPost) throw new Error("cannot clone");
    this.posted.push(m);
  }
  terminate() { this.terminated++; }
}
const job: FormatJob = { kind: "markdown", text: "# x" };
const last = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.throwOnConstruct = false;
  FakeWorker.throwOnPost = false;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 10));
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllGlobals();
  expect(unhandled).toEqual([]);
});

describe("defaultRunner with a fake Worker", () => {
  test("the default timeout is 2 seconds", () => {
    expect(FORMAT_TIMEOUT_MS).toBe(2000);
  });
  test("makes a module worker, sends the job, delivers the result and terminates", async () => {
    const p = defaultRunner(job, 1000);
    const w = last();
    expect(w.options).toEqual({ type: "module" });
    expect(String(w.url)).toContain("format.worker");
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]!.job).toEqual(job);
    w.onmessage!({ data: { id: w.posted[0]!.id, html: "<p>x</p>" } });
    expect(await p).toBe("<p>x</p>");
    expect(w.terminated).toBe(1);
  });
  test("a message with another id is ignored", async () => {
    const p = defaultRunner(job, 1000);
    const w = last();
    w.onmessage!({ data: { id: w.posted[0]!.id + 1, html: "<p>other</p>" } });
    expect(w.terminated).toBe(0);
    w.onmessage!({ data: { id: w.posted[0]!.id, html: "<p>mine</p>" } });
    expect(await p).toBe("<p>mine</p>");
  });
  test("each call makes its own worker", async () => {
    const a = defaultRunner(job, 1000);
    const b = defaultRunner(job, 1000);
    expect(FakeWorker.instances).toHaveLength(2);
    for (const w of FakeWorker.instances) w.onmessage!({ data: { id: w.posted[0]!.id, html: "x" } });
    await Promise.all([a, b]);
    expect(FakeWorker.instances.map((w) => w.terminated)).toEqual([1, 1]);
  });
  test("a timeout gives undefined and terminates the worker, and a late result changes nothing", async () => {
    const p = defaultRunner(job, 20);
    const w = last();
    expect(await p).toBeUndefined();
    expect(w.terminated).toBe(1);
    w.onmessage!({ data: { id: w.posted[0]!.id, html: "late" } });
    expect(w.terminated).toBe(1);
  });
  test("a worker error gives undefined and terminates", async () => {
    const p = defaultRunner(job, 1000);
    last().onerror!(new Error("boom"));
    expect(await p).toBeUndefined();
    expect(last().terminated).toBe(1);
  });
  test("an error message gives undefined and terminates", async () => {
    const p = defaultRunner(job, 1000);
    const w = last();
    w.onmessage!({ data: { id: w.posted[0]!.id, error: "bad" } });
    expect(await p).toBeUndefined();
    expect(w.terminated).toBe(1);
  });
  test("an undefined result gives undefined", async () => {
    const p = defaultRunner(job, 1000);
    const w = last();
    w.onmessage!({ data: { id: w.posted[0]!.id } });
    expect(await p).toBeUndefined();
    expect(w.terminated).toBe(1);
  });
  test("a postMessage that throws gives undefined and terminates", async () => {
    FakeWorker.throwOnPost = true;
    expect(await defaultRunner(job, 1000)).toBeUndefined();
    expect(last().terminated).toBe(1);
  });
  test("a worker that cannot be made gives undefined", async () => {
    FakeWorker.throwOnConstruct = true;
    expect(await defaultRunner(job, 1000)).toBeUndefined();
  });
});

describe("without Worker (vitest and old browsers) the job runs in this process", () => {
  test("markdown gives layer 1 html", async () => {
    vi.stubGlobal("Worker", undefined);
    expect(await defaultRunner({ kind: "markdown", text: "# x" }, 1000)).toContain("<h1>");
    expect(FakeWorker.instances).toHaveLength(0);
  });
  test("the guards still apply", async () => {
    expect(await runInProcess({ kind: "markdown", text: "*".repeat(400) })).toBeUndefined();
  });
});

// The real Worker cannot run under vitest and jsdom. The real browser check proves it.
describe("format.worker", () => {
  test("posts html, or an error, and never throws", async () => {
    const posted: unknown[] = [];
    vi.spyOn(self, "postMessage").mockImplementation(((m: unknown) => { posted.push(m); }) as never);
    await import("./format.worker");
    const onmessage = (self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage;
    await onmessage({ data: { id: 1, job: { kind: "markdown", text: "# x" } } });
    await onmessage({ data: { id: 2, job: { kind: "code", text: "let a", language: "typescript" } } }); // a job of another kind is refused
    await onmessage({ data: { id: 3, job: { kind: "nope" } } });
    await onmessage({ data: null });
    expect(posted[0]).toMatchObject({ id: 1 });
    expect((posted[0] as { html: string }).html).toContain("<h1>");
    expect(posted[1]).toMatchObject({ id: 2, error: expect.any(String) });
    expect(posted[2]).toMatchObject({ id: 3, error: expect.any(String) });
    expect(posted[3]).toMatchObject({ error: expect.any(String) });
  });
});
