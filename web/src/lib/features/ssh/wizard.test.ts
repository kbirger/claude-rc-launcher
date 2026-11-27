import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import type { SshStatus, TargetDetail } from "./api";
import { SSH_KEY } from "./queries";
import { createTargetWizardModel, firstStep } from "./wizard.svelte";

const STATUS: SshStatus = {
  setUp: true,
  method: "passphrase",
  nodes: [{ host: "node1", enabled: true, sourceAddress: "10.0.0.2" }],
} as SshStatus;
const PASS = "correct horse battery";
const detail = (extra: Partial<TargetDetail> = {}): TargetDetail => ({
  id: "nas",
  address: "10.0.0.5",
  port: 22,
  account: "root",
  systemType: "linux",
  nodes: ["node1", "node2"],
  state: "draft",
  notes: ["first note"],
  ...extra,
});

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let answers: Record<string, () => { status?: number; body: unknown }>;
beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const make = answers[`${method} ${path}`];
    const out = make ? make() : path === "/api/hosts" ? { body: [] } : { body: {} };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount(targetId?: string, status: SshStatus = STATUS) {
  const client = new QueryClient();
  const { value: model, dispose } = inRoot(() => createTargetWizardModel({ client, targetId, status: () => status }));
  flushSync();
  return { model, client, dispose };
}

const settled = async (model: { busy: boolean }) => {
  await vi.waitFor(() => expect(model.busy).toBe(false));
  flushSync();
};

describe("firstStep", () => {
  test("starts at the first step that is not done", () => {
    expect(firstStep(detail())).toBe("key");
    expect(firstStep(detail({ keyFingerprint: "k" }))).toBe("hostkey");
    expect(firstStep(detail({ keyFingerprint: "k", hostKey: "h" }))).toBe("install");
    expect(firstStep(detail({ state: "ready" }))).toBe("done");
  });
});

describe("target wizard model", () => {
  test("without a target id it starts on the form and reads no target", async () => {
    const wizard = mount();
    expect(wizard.model.step).toBe("form");
    expect(wizard.model.position).toBe(1);
    await vi.waitFor(() => expect(calls.some((call) => call.url === "/api/hosts")).toBe(true));
    expect(calls.some((call) => call.url.startsWith("/api/ssh/targets/"))).toBe(false);
    wizard.dispose();
  });

  test("the form posts the target and moves to the key step", async () => {
    answers["POST /api/ssh/targets"] = () => ({ body: detail() });
    const wizard = mount();
    void wizard.model.submitForm({ id: "nas", account: "root", systemType: "linux", nodes: ["node1"] });
    await settled(wizard.model);
    expect(wizard.model.step).toBe("key");
    expect(wizard.model.target?.id).toBe("nas");
    wizard.dispose();
  });

  test("with a target id it waits for the target, then starts at its first open step", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail({ keyFingerprint: "k" }) });
    const wizard = mount("nas");
    expect(wizard.model.step).toBeNull();
    expect(wizard.model.position).toBe(0);
    await vi.waitFor(() => expect(wizard.model.step).toBe("hostkey"));
    expect(wizard.model.notes).toEqual(["first note"]);
    wizard.dispose();
  });

  test("a refetch of the target with new data never moves the step or the target", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail() });
    answers["POST /api/ssh/targets/nas/key"] = () => ({
      body: { publicLine: "p", fingerprint: "f", installLine: "LINE", notes: ["key note"] },
    });
    const wizard = mount("nas");
    await vi.waitFor(() => expect(wizard.model.step).toBe("key"));
    wizard.model.passphrase = PASS;
    void wizard.model.makeKey();
    await settled(wizard.model);
    expect(wizard.model.step).toBe("hostkey");
    expect(wizard.model.notes).toEqual(["key note"]);
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail({ state: "ready", id: "nas", nodes: ["node3"] }) });
    await wizard.client.refetchQueries({ queryKey: [...SSH_KEY, "target", "nas"] });
    flushSync();
    expect(wizard.model.step).toBe("hostkey");
    expect(wizard.model.notes).toEqual(["key note"]);
    expect(wizard.model.target?.nodes).toEqual(["node1", "node2"]);
    answers["GET /api/ssh/targets/nas"] = () => ({ status: 500, body: { error: "down" } });
    await wizard.client.refetchQueries({ queryKey: [...SSH_KEY, "target", "nas"] });
    flushSync();
    expect(wizard.model.step).toBe("hostkey");
    wizard.dispose();
  });

  test("a short passphrase for the first key is refused before any call, and stays typed", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail() });
    const wizard = mount("nas", { ...STATUS, hasKeys: false } as SshStatus);
    await vi.waitFor(() => expect(wizard.model.step).toBe("key"));
    wizard.model.passphrase = "short";
    void wizard.model.makeKey();
    await settled(wizard.model);
    expect(wizard.model.problem).toMatch(/characters/);
    expect(wizard.model.passphrase).toBe("short");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    wizard.dispose();
  });

  test("a failed key call clears the passphrase and stays on the step", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail() });
    answers["POST /api/ssh/targets/nas/key"] = () => ({ status: 403, body: { error: "wrong unlock" } });
    const wizard = mount("nas");
    await vi.waitFor(() => expect(wizard.model.step).toBe("key"));
    wizard.model.passphrase = PASS;
    void wizard.model.makeKey();
    await settled(wizard.model);
    expect(wizard.model.problem).toBe("wrong unlock");
    expect(wizard.model.passphrase).toBe("");
    expect(wizard.model.step).toBe("key");
    wizard.dispose();
  });

  test("the node is the first allowed one until the owner chooses another", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail({ keyFingerprint: "k" }) });
    answers["POST /api/ssh/targets/nas/scan"] = () => ({
      body: { keys: [{ line: "ssh-ed25519 H", fingerprint: "F" }] },
    });
    const wizard = mount("nas");
    await vi.waitFor(() => expect(wizard.model.step).toBe("hostkey"));
    expect(wizard.model.node).toBe("node1");
    wizard.model.node = "node2";
    expect(wizard.model.node).toBe("node2");
    wizard.model.node = "gone";
    expect(wizard.model.node).toBe("node1");
    wizard.model.node = "node2";
    void wizard.model.scanKey();
    await settled(wizard.model);
    expect(calls.find((call) => call.url.endsWith("/scan"))?.body).toEqual({ node: "node2" });
    expect(wizard.model.found).toHaveLength(1);
    expect(wizard.model.matched).toBe(false);
    void wizard.model.pinScanned();
    await settled(wizard.model);
    expect(calls.some((call) => call.url.endsWith("/pin"))).toBe(false);
    wizard.dispose();
  });

  test("the install step reads the script only when it has no line, and I installed it moves on", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail({ keyFingerprint: "k", hostKey: "h" }) });
    answers["GET /api/ssh/targets/nas/provision"] = () => ({ body: { shell: "sh", script: "echo hi" } });
    const wizard = mount("nas");
    await vi.waitFor(() => expect(wizard.model.step).toBe("install"));
    await vi.waitFor(() => expect(wizard.model.script.data?.script).toBe("echo hi"));
    wizard.model.installed();
    expect(wizard.model.step).toBe("test");
    wizard.dispose();
  });

  test("a failed test shows its error, and a passed test ends on done", async () => {
    answers["GET /api/ssh/targets/nas"] = () => ({ body: detail({ keyFingerprint: "k", hostKey: "h" }) });
    answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: false, error: "refused" } });
    const wizard = mount("nas");
    await vi.waitFor(() => expect(wizard.model.step).toBe("install"));
    wizard.model.installed();
    wizard.model.passphrase = PASS;
    void wizard.model.runTest();
    await settled(wizard.model);
    expect(wizard.model.testFailure).toBe("refused");
    expect(wizard.model.passphrase).toBe("");
    answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: true } });
    wizard.model.passphrase = PASS;
    void wizard.model.runTest();
    await settled(wizard.model);
    expect(wizard.model.testFailure).toBe("");
    expect(wizard.model.step).toBe("done");
    wizard.dispose();
  });
});
