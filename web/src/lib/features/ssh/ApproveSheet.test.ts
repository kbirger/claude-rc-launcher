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
let listed: Grant[];
const open: Array<() => void> = [];

beforeEach(() => {
  calls = [];
  closed = 0;
  listed = [];
  approveAnswer = { status: 200, body: { ...GRANT, state: "active" } };
  prf.unlockWithPasskey.mockReset();
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let out: { status: number; body: unknown } = { status: 200, body: {} };
    if (path === "/api/ssh/targets") out = { status: 200, body: [TARGET] };
    else if (path === "/api/ssh/grants") out = { status: 200, body: listed };
    else if (path === "/api/hosts") out = { status: 200, body: [] };
    else if (path === "/api/ssh/targets/nas/salt?key=provisioner") out = { status: 200, body: { salt: "cHJvdg" } };
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
const buttons = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.trim() === label);
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

test("the passphrase field is a current password with one visible-to-managers user name field", async () => {
  show(PASSPHRASE);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(field.autocomplete).toBe("current-password");
  expect(field.name).toBe("claude-rc-ssh-passphrase");
  const users = document.querySelectorAll<HTMLInputElement>('input[autocomplete="username"]');
  expect(users).toHaveLength(1);
  expect(users[0]!.value).toBe("claude-rc-ssh");
  expect(users[0]!.hidden).toBe(false);
  expect(users[0]!.type).toBe("text");
  expect(users[0]!.classList.contains("sr-only")).toBe(true);
});

const MAINT: Grant = {
  ...GRANT,
  nodeId: "local",
  instanceId: "maintenance",
  minutes: 1,
  reason: undefined,
  maintenance: {
    action: "sources",
    fromNodes: ["node1"],
    toNodes: ["node2"],
    fromSources: ["192.168.1.10"],
    toSources: ["192.168.1.20"],
  },
};

test("the sheet of a maintenance grant asks for the provisioner salt", async () => {
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(closed).toBe(1));
  const urls = calls.map((call) => `${call.method} ${call.url}`);
  expect(urls).toContain("GET /api/ssh/targets/nas/salt?key=provisioner");
  expect(urls).not.toContain("GET /api/ssh/targets/nas/salt");
  expect(prf.unlockWithPasskey).toHaveBeenCalledWith("cred1", "cHJvdg");
});

test("the sheet hides the minutes field for a maintenance grant", async () => {
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  expect(document.querySelector('input[type="number"]')).toBeNull();
  button("Approve").click();
  await vi.waitFor(() => expect(approves()).toHaveLength(1));
  expect(approves()[0]!.body).toEqual({ unlock: { method: "prf", secret: "c2VjcmV0" } });
});

test("the sheet shows the old and the new nodes with their addresses for sources", async () => {
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  const text = document.body.textContent!;
  expect(text).toContain("Change the nodes");
  expect(text).toContain("This changes the key line on nas");
  expect(text).toContain("SSH will be allowed only from: 192.168.1.20");
  expect(text).toContain("from: 192.168.1.10");
  expect(text).toContain("Nodes now: node1. Nodes after: node2.");
});

test("the sheet shows the maintenance warning in place of the account warning", async () => {
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  const text = document.body.textContent!;
  expect(text).not.toContain(WARNING);
  expect(text).not.toContain("claimed by the session");
  expect(text).toContain("Approve SSH maintenance");
  expect(text).toContain("provisioner key");
});

test("the sheet shows the result detail after a 502 from the record of the grant", async () => {
  // The real hub answers an error with a text only. The detail is in the record of the grant.
  approveAnswer = { status: 502, body: { error: "the change was not stored" } };
  listed = [
    { ...MAINT, state: "ended", maintenance: { ...MAINT.maintenance!, result: "failed", detail: "the script failed" } },
  ];
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("the script failed"));
  expect(document.querySelector("[role=alert]")?.textContent).toContain("The change failed");
  expect(closed).toBe(0);
  expect(buttons("Approve")).toHaveLength(0);
});

test("an empty detail in the record falls back to the error text", async () => {
  approveAnswer = { status: 502, body: { error: "the run on the target took too long" } };
  listed = [{ ...MAINT, state: "ended", maintenance: { ...MAINT.maintenance!, result: "failed", detail: "" } }];
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("the run on the target took too long"),
  );
  expect(document.querySelector("[role=alert]")?.textContent).toContain("The change failed. the run");
});

test("an empty detail in a 200 answer says that the run failed", async () => {
  approveAnswer = {
    status: 200,
    body: { ...MAINT, state: "ended", maintenance: { ...MAINT.maintenance, result: "failed", detail: "" } },
  };
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("The change failed. The run gave no detail."),
  );
});

test("the sheet keeps the error text when the record has no result", async () => {
  approveAnswer = { status: 502, body: { error: "the node is gone" } };
  listed = [MAINT];
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("the node is gone"));
  expect(buttons("Approve")).toHaveLength(1);
});

test("the sheet says that the list of addresses does not change", async () => {
  show(PRF, { ...MAINT, maintenance: { ...MAINT.maintenance!, toSources: ["192.168.1.10"], toNodes: ["node3"] } });
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  expect(document.body.textContent).toContain("The list of addresses does not change: 192.168.1.10");
  expect(document.body.textContent).not.toContain("SSH will be allowed only from");
});

test("the sheet shows none for an empty list and a retire text", async () => {
  show(PRF, { ...MAINT, maintenance: { action: "uninstall", fromNodes: [], fromSources: [] } });
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  const text = document.body.textContent!;
  expect(text).toContain("This removes the key line on nas.");
  expect(text).not.toContain("This changes the key line");
  expect(text).toContain("The addresses now allowed: none");
});

test("the sheet shows a failed result that the hub answers with 200", async () => {
  approveAnswer = {
    status: 200,
    body: { ...MAINT, state: "ended", maintenance: { ...MAINT.maintenance, result: "failed", detail: "no luck" } },
  };
  show(PRF, MAINT);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("no luck"));
  expect(closed).toBe(0);
  expect(buttons("Approve")).toHaveLength(0);
  button("Close").click();
  expect(closed).toBe(1);
});

test("a session sheet still asks for the main salt", async () => {
  show();
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(closed).toBe(1));
  expect(calls.map((call) => call.url)).toContain("/api/ssh/targets/nas/salt");
});

const UNINSTALL: Grant = {
  ...MAINT,
  maintenance: { action: "uninstall", fromNodes: ["node1"], fromSources: ["10.0.0.1"] },
};
const RETIRED = {
  id: "nas",
  account: "root",
  address: "10.0.0.5",
  port: 2222,
  systemType: "linux",
  managed: false,
  line: "failed",
  detail: "connect refused",
  comments: ["claude-rc:nas", "claude-rc-provisioner:nas"],
  script: "/home/root/p-nas.sh",
};

test("the sheet shows the retire notice for an uninstall answer and offers Close only", async () => {
  approveAnswer = {
    status: 200,
    body: {
      ...UNINSTALL,
      state: "ended",
      maintenance: { ...UNINSTALL.maintenance, result: "failed", detail: "connect refused" },
      retired: RETIRED,
    },
  };
  show(PRF, UNINSTALL);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  const status = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="status"]');
    expect(found).not.toBeNull();
    return found!;
  });
  const text = status.textContent!.replace(/\s+/g, " ");
  expect(text).toContain("Retired nas. The hub did not remove the key lines from root@10.0.0.5: connect refused.");
  expect(text).toContain("claude-rc:nas and claude-rc-provisioner:nas");
  expect(document.body.textContent).not.toContain("The change failed.");
  expect(buttons("Approve")).toHaveLength(0);
  expect(closed).toBe(0);
  button("Close").click();
  expect(closed).toBe(1);
});

test("an approved uninstall that removed the lines says so", async () => {
  approveAnswer = {
    status: 200,
    body: { ...UNINSTALL, state: "ended", retired: { ...RETIRED, line: "removed", comments: undefined } },
  };
  show(PRF, UNINSTALL);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Retired nas. The key line was removed"));
});

test("a 409 that says the grant ended before the run finishes the sheet and removes Approve", async () => {
  approveAnswer = {
    status: 409,
    body: {
      error:
        "the grant ended before the run started, so the target stays disabled: retire it again, or retire it without cleanup",
    },
  };
  show(PRF, UNINSTALL);
  await vi.waitFor(() => expect(document.body.textContent).toContain("10.0.0.5"));
  button("Approve").click();
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("The grant ended before the run started"),
  );
  expect(buttons("Approve")).toHaveLength(0);
  expect(button("Close")).toBeDefined();
});
