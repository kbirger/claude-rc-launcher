// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Grant, SshStatus } from "./api";
import ApproveSheetHarness from "./ApproveSheetHarness.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));

type Call = { method: string; url: string; body: unknown };
const WARNING = "This gives the full power of the account on the target. The target cannot limit it to read-only.";
const PASS = "correct horse battery";

const GRANT: Grant = {
  id: "g1",
  nodeId: "node1",
  instanceId: "inst1",
  targetId: "nas",
  minutes: 45,
  reason: "deploy the fix",
  test: false,
  state: "pending",
  requestedAt: 1000,
};
const PRF: SshStatus = { setUp: true, method: "prf", credentialId: "cred1", nodes: [] };
const PASSPHRASE: SshStatus = { setUp: true, method: "passphrase", nodes: [] };
const TARGET = {
  id: "nas",
  address: "10.0.0.5",
  port: 2222,
  account: "root",
  systemType: "linux",
  nodes: ["node1"],
  state: "ready",
};

let calls: Call[];
let approveAnswer: { status: number; body: unknown };
let closed: number;
const open: Array<() => void> = [];

beforeEach(() => {
  calls = [];
  closed = 0;
  approveAnswer = { status: 200, body: { ...GRANT, state: "active" } };
  prf.unlockWithPasskey.mockReset();
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let out: { status: number; body: unknown } = { status: 200, body: {} };
    if (path === "/api/ssh/targets") out = { status: 200, body: [TARGET] };
    else if (path === "/api/hosts") out = { status: 200, body: [] };
    else if (path === "/api/ssh/targets/nas/salt") out = { status: 200, body: { salt: "c2FsdA" } };
    else if (path === "/api/ssh/grants/g1/approve") out = approveAnswer;
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

function show(status: SshStatus = PRF, grant: Grant = GRANT) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(ApproveSheetHarness, {
    target,
    props: { client: createQueryClient(), grant, status, onclose: () => closed++ },
  });
  open.push(() => unmount(mounted));
  flushSync();
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const approves = () => calls.filter((call) => call.url === "/api/ssh/grants/g1/approve");

function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

test("ApproveSheet shows the warning text exactly", async () => {
  show();
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  const text = document.body.textContent!;
  expect(text).toContain(WARNING);
  expect(text).toContain("node1");
  expect(text).toContain("claimed by the session");
  expect(text).toContain("root@10.0.0.5:2222");
  expect(text).toContain("deploy the fix");
  expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("45");
});

test("ApproveSheet sends the unlock with the approval", async () => {
  show();
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  type(document.querySelector<HTMLInputElement>('input[type="number"]')!, "30");
  button("Approve").click();
  await vi.waitFor(() => expect(closed).toBe(1));
  expect(prf.unlockWithPasskey).toHaveBeenCalledWith("cred1", "c2FsdA");
  expect(calls.map((call) => `${call.method} ${call.url}`)).toContain("GET /api/ssh/targets/nas/salt");
  expect(approves()).toEqual([
    {
      method: "POST",
      url: "/api/ssh/grants/g1/approve",
      body: { unlock: { method: "prf", secret: "c2VjcmV0" }, minutes: 30 },
    },
  ]);
});

test("a passphrase unlock is sent and the field is cleared after the call", async () => {
  approveAnswer = { status: 403, body: { error: "wrong unlock" } };
  show(PASSPHRASE);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  type(field, PASS);
  button("Approve").click();
  await vi.waitFor(() => expect(approves().length).toBe(1));
  expect((approves()[0]!.body as { unlock: { method: string } }).unlock.method).toBe("passphrase");
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(""));
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
});

test("a wrong unlock shows the error and the sheet stays open", async () => {
  approveAnswer = { status: 403, body: { error: "wrong unlock" } };
  show();
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("wrong unlock"));
  expect(closed).toBe(0);
  expect(document.body.textContent).toContain(WARNING);
  expect(button("Approve").disabled).toBe(false);
});

test("minutes outside 1 to 480 are not sent", async () => {
  show();
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  type(document.querySelector<HTMLInputElement>('input[type="number"]')!, "481");
  button("Approve").click();
  await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("1 to 480"));
  expect(approves()).toEqual([]);
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
});
