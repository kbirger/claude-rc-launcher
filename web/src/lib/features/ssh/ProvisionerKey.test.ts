// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { SshStatus } from "./api";
import { UnlockError } from "./prf";
import ProvisionerKeyHarness from "./ProvisionerKeyHarness.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));

type Call = { method: string; url: string; body: unknown };
const PRF: SshStatus = { setUp: true, method: "prf", credentialId: "cred1", pendingRewrap: [], nodes: [] };
const PASSPHRASE: SshStatus = { setUp: true, method: "passphrase", pendingRewrap: [], nodes: [] };
const TARGET = {
  id: "nas",
  address: "10.0.0.5",
  port: 22,
  account: "root",
  systemType: "linux",
  nodes: ["node1"],
  state: "ready",
  keyFingerprint: "SHA256:main",
  notes: [],
};

let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;
let closed: number;
const open: Array<() => void> = [];

beforeEach(() => {
  calls = [];
  closed = 0;
  answers = {
    "GET /api/ssh/targets/nas": { status: 200, body: TARGET },
    "GET /api/ssh/targets/nas/salt?key=provisioner": { status: 200, body: { salt: "cHJvdg" } },
    "POST /api/ssh/targets/nas/provisioner-key": {
      status: 200,
      body: { publicLine: "ssh-ed25519 AAAA", fingerprint: "SHA256:prov" },
    },
  };
  prf.unlockWithPasskey.mockReset();
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const found = answers[`${method} ${path}`] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(found.body), {
      status: found.status,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

function show(status: SshStatus = PRF) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(ProvisionerKeyHarness, {
    target,
    props: { client: createQueryClient(), targetId: "nas", status, onclose: () => closed++ },
  });
  open.push(() => unmount(mounted));
  flushSync();
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const waitText = (text: string) => vi.waitFor(() => expect(document.body.textContent).toContain(text));
const squash = () => document.body.textContent!.replace(/\s+/g, " ");

test("the card makes the provisioner key with the passkey of the provisioner salt", async () => {
  show();
  await waitText("Make the key");
  button("Make the key").click();
  await waitText("The provisioner key is made.");
  expect(prf.unlockWithPasskey).toHaveBeenCalledWith("cred1", "cHJvdg");
  expect(calls.filter((call) => call.method === "POST")).toEqual([
    {
      method: "POST",
      url: "/api/ssh/targets/nas/provisioner-key",
      body: { unlock: { method: "prf", secret: "c2VjcmV0" } },
    },
  ]);
  expect(squash()).toContain("Go back to the command on your own machine.");
  expect(document.body.textContent).toContain("SHA256:prov");
  expect(document.body.textContent).not.toContain("AAAA");
  button("Close").click();
  expect(closed).toBe(1);
});

test("a key that exists already is not an error: the command can use it", async () => {
  answers["POST /api/ssh/targets/nas/provisioner-key"] = {
    status: 409,
    body: { error: "the target has a provisioner key already" },
  };
  show();
  await waitText("Make the key");
  button("Make the key").click();
  await waitText("The hub already holds a provisioner key for this target.");
  expect(document.querySelector("[role=alert]")).toBeNull();
});

test("a failed unlock shows the text and keeps the button", async () => {
  prf.unlockWithPasskey.mockRejectedValue(new Error("The passkey was not used."));
  show();
  await waitText("Make the key");
  button("Make the key").click();
  await waitText("The passkey was not used.");
  expect(squash()).toContain("Try again, or close this card.");
  expect(button("Make the key").disabled).toBe(false);
});

test("with a passphrase the card asks for it and clears the field", async () => {
  show(PASSPHRASE);
  await waitText("Make the key");
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  field.value = "correct horse battery";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  button("Make the key").click();
  await waitText("The provisioner key is made.");
  const body = calls.find((call) => call.method === "POST")!.body as { unlock: { method: string } };
  expect(body.unlock.method).toBe("passphrase");
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
});

test("a managed target gets no key and a way out", async () => {
  answers["GET /api/ssh/targets/nas"] = { status: 200, body: { ...TARGET, managedHost: "node2" } };
  show();
  await waitText("A managed target has no provisioner key.");
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  button("Cancel").click();
  expect(closed).toBe(1);
});

test("a browser without PRF shows the text of the error and keeps the button", async () => {
  prf.unlockWithPasskey.mockRejectedValue(new UnlockError("This passkey does not return a PRF secret"));
  show();
  await waitText("Make the key");
  button("Make the key").click();
  await waitText("This passkey does not return a PRF secret");
  expect(button("Make the key").disabled).toBe(false);
});

test("a wrong passphrase gives 403 and the card shows the text", async () => {
  answers["POST /api/ssh/targets/nas/provisioner-key"] = { status: 403, body: { error: "wrong unlock" } };
  show(PASSPHRASE);
  await waitText("Make the key");
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  field.value = "wrong wrong wrong";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  button("Make the key").click();
  await waitText("wrong unlock");
  expect(field.value).toBe("");
  expect(document.body.textContent).not.toContain("The provisioner key is made.");
});

test.each([
  ["a windows target", { systemType: "windows" }, "A Windows target has no provisioner key"],
  ["a dropbear target", { systemType: "dropbear" }, "The provisioner for a dropbear target is not available yet."],
  ["a managed target", { managedHost: "node2" }, "A managed target has no provisioner key."],
  ["a target without a key", { keyFingerprint: undefined }, "This target has no key yet."],
])("%s gets a fitting refusal and no button", async (_name, extra, text) => {
  answers["GET /api/ssh/targets/nas"] = { status: 200, body: { ...TARGET, ...extra } };
  show();
  await waitText(text);
  expect(document.body.textContent).not.toContain("Make the key");
});

test.each([
  [403, "Only an admin can make the provisioner key."],
  [404, "The hub has no target named nas."],
  [500, "The hub did not load the target. Open the link again."],
])("a load error %i gives a fitting text", async (code, text) => {
  answers["GET /api/ssh/targets/nas"] = { status: code, body: { error: "x" } };
  show();
  await waitText(text);
});
