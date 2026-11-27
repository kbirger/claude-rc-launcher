// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { SshStatus, TargetDetail } from "./api";
import TargetWizardHarness from "./TargetWizardHarness.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));

type Call = { method: string; url: string; body: unknown };
const LINE = 'from="10.0.0.2",restrict ssh-ed25519 AAAAKEY claude-rc:nas';
const ED = "ssh-ed25519 AAAAHOSTED";
const RSA = "ssh-rsa AAAAHOSTRSA";
const PASS = "correct horse battery";

let calls: Call[];
let answers: Record<string, (body: unknown) => { status?: number; body: unknown }>;
let closed: number;
const open: Array<() => void> = [];

const PRF: SshStatus = {
  setUp: true,
  method: "prf",
  credentialId: "cred1",
  nodes: [
    { host: "node1", enabled: true, sourceAddress: "10.0.0.2" },
    { host: "node2", enabled: false, sourceAddress: "" },
  ],
};
const BOTH: SshStatus = {
  ...PRF,
  nodes: [
    { host: "node1", enabled: true, sourceAddress: "10.0.0.2" },
    { host: "node2", enabled: true, sourceAddress: "10.0.0.3" },
  ],
};
const NO_NODE = "No node of this target has SSH access on. Turn it on, with a source address, on the Nodes card.";
const PASSPHRASE: SshStatus = { ...PRF, method: "passphrase", credentialId: undefined };

const detail = (extra: Partial<TargetDetail> = {}): TargetDetail => ({
  id: "nas",
  address: "10.0.0.5",
  port: 22,
  account: "root",
  systemType: "synology",
  nodes: ["node1"],
  state: "draft",
  notes: ["Synology note"],
  ...extra,
});

beforeEach(() => {
  calls = [];
  closed = 0;
  answers = {};
  prf.unlockWithPasskey.mockReset();
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: path, body });
    const make = answers[`${method} ${path}`];
    const out = make ? make(body) : path === "/api/hosts" ? { body: [] } : { body: {} };
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

function show(status: SshStatus, targetId?: string, client = createQueryClient()) {
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = mount(TargetWizardHarness, {
    target: container,
    props: { client, status, targetId, onclose: () => closed++ },
  });
  open.push(() => unmount(mounted));
  flushSync();
  return client;
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

const press = (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`no button ${label}`);
  found.click();
  flushSync();
};

const typeInto = (selector: string, text: string) => {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

// bits-ui opens a select on ArrowDown, and picks an option on pointer up, so the tests send those events.
const openSelect = async (trigger: HTMLElement) => {
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
};

const pick = async (selector: string, value: string) => {
  await openSelect(document.querySelector<HTMLElement>(selector)!);
  const option = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
  for (const type of ["pointermove", "pointerdown", "pointerup"])
    option.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", button: 0 }));
  option.click();
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')).toBeNull());
  flushSync();
};

const waitText = (text: string) => vi.waitFor(() => expect(document.body.textContent).toContain(text));
const posts = () => calls.filter((call) => call.method === "POST");
const label = (text: string) =>
  [...document.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.includes(text))!;

// The sheet is in a portal, so every query goes through the document.
const resumeAt = async (extra: Partial<TargetDetail>, status = PRF) => {
  answers["GET /api/ssh/targets/nas"] = () => ({ body: detail(extra) });
  answers["GET /api/ssh/targets/nas/salt"] = () => ({ body: { salt: "c2FsdA" } });
  const client = show(status, "nas");
  await waitText("Step");
  await vi.waitFor(() => expect(document.body.textContent).not.toContain("Loading the target"));
  return client;
};

const KEY_ANSWER = { publicLine: "ssh-ed25519 AAAAKEY claude-rc:nas", fingerprint: "SHA256:key", installLine: LINE };

test("the wizard does not show the install line before the key exists", async () => {
  answers["GET /api/ssh/targets/nas/salt"] = () => ({ body: { salt: "c2FsdA" } });
  answers["POST /api/ssh/targets"] = () => ({ body: detail({ notes: undefined } as never) });
  answers["POST /api/ssh/targets/nas/key"] = () => ({ body: { ...KEY_ANSWER, notes: ["Synology note"] } });
  show(PRF);
  typeInto('input[id$="-id"]', "nas");
  typeInto('input[id$="-address"]', "10.0.0.5");
  typeInto('input[id$="-account"]', "root");
  label("node1").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  press("Create target");
  await waitText("Step 2 of 6: Key");
  expect(document.body.textContent).not.toContain("AAAAKEY");
  expect(document.body.textContent).not.toContain("authorized_keys");
  expect(posts()[0]).toMatchObject({
    url: "/api/ssh/targets",
    body: { id: "nas", account: "root", systemType: "linux", nodes: ["node1"], address: "10.0.0.5" },
  });

  press("Create key");
  await waitText("Step 3 of 6: Host key");
  // Still no line: the host key comes first.
  expect(document.body.textContent).not.toContain("AAAAKEY");
});

test("the wizard blocks the pin step until the admin selects They match", async () => {
  answers["POST /api/ssh/targets/nas/scan"] = () => ({
    body: {
      keys: [
        { line: RSA, fingerprint: "SHA256:rsa" },
        { line: ED, fingerprint: "SHA256:ed" },
      ],
    },
  });
  answers["POST /api/ssh/targets/nas/pin"] = () => ({ body: detail({ hostKey: ED }) });
  await resumeAt({ keyFingerprint: "SHA256:key" });
  expect(document.body.textContent).toContain("Step 3 of 6: Host key");
  press("Scan host key");
  await waitText("SHA256:ed");
  expect(document.body.textContent).toContain("SHA256:rsa");
  expect(button("Pin host key")!.disabled).toBe(true);
  press("Pin host key");
  expect(posts().some((call) => call.url.endsWith("/pin"))).toBe(false);
  expect(posts().find((call) => call.url.endsWith("/scan"))!.body).toEqual({ node: "node1" });

  label("They match").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  expect(button("Pin host key")!.disabled).toBe(false);
  press("Pin host key");
  await waitText("Step 4 of 6: Install");
  expect(posts().find((call) => call.url.endsWith("/pin"))!.body).toEqual({ hostKey: ED });
});

test("the pin sends the first line when no key is ed25519", async () => {
  answers["POST /api/ssh/targets/nas/scan"] = () => ({ body: { keys: [{ line: RSA, fingerprint: "SHA256:rsa" }] } });
  answers["POST /api/ssh/targets/nas/pin"] = () => ({ body: detail({ hostKey: RSA }) });
  await resumeAt({ keyFingerprint: "SHA256:key" });
  press("Scan host key");
  await waitText("SHA256:rsa");
  label("They match").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  press("Pin host key");
  await waitText("Step 4 of 6: Install");
  expect(posts().find((call) => call.url.endsWith("/pin"))!.body).toEqual({ hostKey: RSA });
});

test("the wizard shows the notes for the chosen system type", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, notes: ["Open DSM, then Terminal."] });
  expect(document.body.textContent).toContain("Open DSM, then Terminal.");
  expect(document.body.textContent).toContain("claude-rc ssh target add");
});

test("the install step shows the line of the key answer with a Copy button", async () => {
  answers["POST /api/ssh/targets/nas/key"] = () => ({ body: { ...KEY_ANSWER, notes: ["Fresh note"] } });
  answers["GET /api/ssh/targets/nas/salt"] = () => ({ body: { salt: "c2FsdA" } });
  answers["POST /api/ssh/targets/nas/scan"] = () => ({ body: { keys: [{ line: ED, fingerprint: "SHA256:ed" }] } });
  answers["POST /api/ssh/targets/nas/pin"] = () => ({ body: detail({ hostKey: ED }) });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await resumeAt({});
  press("Create key");
  await waitText("Step 3 of 6");
  press("Scan host key");
  await waitText("SHA256:ed");
  label("They match").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  press("Pin host key");
  await waitText("Step 4 of 6");
  expect(document.querySelector("code")!.textContent!.trim()).toBe(LINE);
  expect(document.body.textContent).toContain("Fresh note");
  press("Copy");
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(LINE));
});

test("the install step of a dropbear target says that the router does not limit the key by address", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, systemType: "dropbear" });
  const text = document.querySelector("[data-dropbear-line]")!.textContent!.replace(/\s+/g, " ");
  expect(text).toContain("Dropbear does not support from=");
  expect(text).toContain("Your approval of each request is the control.");
  expect(document.body.textContent).not.toContain("The line limits the key to the source addresses");
});

test("the wizard resumes at the unlock step for a target with no key", async () => {
  await resumeAt({});
  expect(document.body.textContent).toContain("Step 2 of 6: Key");
  expect(button("Create key")).toBeDefined();
  press("Create key");
  await vi.waitFor(() => expect(prf.unlockWithPasskey).toHaveBeenCalled());
  expect(prf.unlockWithPasskey).toHaveBeenCalledWith("cred1", "c2FsdA");
  const key = await vi.waitFor(() => {
    const found = posts().find((call) => call.url === "/api/ssh/targets/nas/key");
    expect(found).toBeDefined();
    return found!;
  });
  expect(key.body).toEqual({ unlock: { method: "prf", secret: "c2VjcmV0" } });
});

test("the wizard never offers the key step when the target has a key", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key" });
  expect(button("Create key")).toBeUndefined();
  expect(document.body.textContent).toContain("Step 3 of 6: Host key");
});

test("the wizard resumes at the install step with a key and a host key, and at done for a ready target", async () => {
  answers["GET /api/ssh/targets/nas/provision"] = () => ({ body: { shell: "sh", script: "echo install-script" } });
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED });
  expect(document.body.textContent).toContain("Step 4 of 6: Install");
  await waitText("echo install-script");
  expect(button("I installed it")).toBeDefined();
});

test("a ready target resumes at the done screen", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, state: "ready" });
  expect(document.body.textContent).toContain("is ready");
  expect(button("Close")).toBeDefined();
});

test("a managed target shows Install on the node and no paste step", async () => {
  answers["POST /api/ssh/targets/nas/authorize"] = () => ({ body: { ok: true } });
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: "ssh-ed25519 AAAA", managedHost: "node1" });
  expect(document.body.textContent).toContain("Step 4 of 6: Install");
  expect(button("Install on the node")).toBeDefined();
  expect(button("Copy")).toBeUndefined();
  expect(button("I installed it")).toBeUndefined();
  expect(document.querySelector("code")).toBeNull();
  expect(calls.some((call) => call.url.endsWith("/provision"))).toBe(false);
  press("Install on the node");
  await waitText("Step 5 of 6: Test");
  expect(posts().find((call) => call.url.endsWith("/authorize"))).toBeDefined();
});

test("a managed target pins the host key from the node without a question", async () => {
  answers["POST /api/ssh/targets/nas/pin-managed"] = () => ({
    body: { keys: [{ line: ED, fingerprint: "SHA256:ed" }] },
  });
  await resumeAt({ keyFingerprint: "SHA256:key", managedHost: "node1" });
  expect(document.body.textContent).not.toContain("They match");
  press("Pin from the node");
  await waitText("Step 4 of 6: Install");
  expect(posts().find((call) => call.url.endsWith("/pin-managed"))).toBeDefined();
});

test("the type list holds linux, windows, synology and dropbear and nothing else", async () => {
  show(PRF);
  const trigger = document.querySelector<HTMLElement>('[id$="-type"]')!;
  expect(trigger.labels[0]?.textContent).toBe("System type");
  expect(trigger.textContent?.trim()).toBe("linux");
  await openSelect(trigger);
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((item) => item.dataset.value);
  expect(options).toEqual(["linux", "windows", "synology", "dropbear"]);
});

test("the form lists only the nodes with SSH access on, none checked, and checks the id", () => {
  show(PRF);
  const boxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
  expect(boxes.map((box) => box.dataset.value)).toEqual(["node1"]);
  expect(boxes[0]!.getAttribute("aria-checked")).toBe("false");
  expect(boxes[0]!.labels[0]?.textContent).toContain("node1");
  typeInto('input[id$="-id"]', "Bad Id");
  typeInto('input[id$="-address"]', "x");
  typeInto('input[id$="-account"]', "root");
  boxes[0]!.click();
  flushSync();
  expect(button("Create target")!.disabled).toBe(true);
  typeInto('input[id$="-id"]', "good-id");
  expect(button("Create target")!.disabled).toBe(false);
});

test("a managed target is sent with its managed host and an optional address", async () => {
  answers["GET /api/hosts"] = () => ({ body: [{ id: "node2", name: "Box", status: "ok" }] });
  answers["POST /api/ssh/targets"] = () => ({ body: detail({ managedHost: "node2" }) });
  show(PRF);
  label("Managed").querySelector<HTMLElement>('[role="radio"]')!.click();
  flushSync();
  typeInto('input[id$="-id"]', "box");
  await pick('[id$="-host"]', "node2");
  await pick('[id$="-type"]', "windows");
  typeInto('input[id$="-account"]', "admin");
  label("node1").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  press("Create target");
  await waitText("Step 2 of 6");
  expect(posts()[0]!.body).toEqual({
    id: "box",
    account: "admin",
    systemType: "windows",
    nodes: ["node1"],
    managedHost: "node2",
  });
});

const keyFileInput = () => document.querySelector<HTMLInputElement>('input[id$="-keyfile"]');

test("the key file field shows only for a managed linux or synology target", async () => {
  answers["GET /api/hosts"] = () => ({ body: [{ id: "node2", name: "Box", status: "ok" }] });
  show(PRF);

  // External: hidden for every type.
  for (const type of ["linux", "synology", "windows", "dropbear"]) {
    await pick('[id$="-type"]', type);
    expect(keyFileInput()).toBeNull();
  }

  label("Managed").querySelector<HTMLElement>('[role="radio"]')!.click();
  flushSync();

  for (const type of ["linux", "synology"]) {
    await pick('[id$="-type"]', type);
    expect(keyFileInput()).not.toBeNull();
  }

  for (const type of ["windows", "dropbear"]) {
    await pick('[id$="-type"]', type);
    expect(keyFileInput()).toBeNull();
  }

  await pick('[id$="-type"]', "synology");
  expect(keyFileInput()!.value).toBe("");
  expect(document.body.textContent).toContain(
    "Use another file when a job rewrites authorized_keys. sshd must list the file in AuthorizedKeysFile.",
  );
  expect(document.body.textContent).toContain("To change the file later, retire the target and add it again.");
});

const LINUX_HELP =
  "Empty uses authorized_keys.claude-rc, a file that no other tool writes. Type authorized_keys to use the main file.";
const DROPIN_HELP =
  "A node installed before this release needs the sshd drop-in once. Run sudo claude-rc node sshd install on it.";
const RETIRE_HELP = "To change the file later, retire the target and add it again.";
// The text of the page with each run of white space as one space: the markup wraps long lines.
const flatText = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

test("the key file field shows authorized_keys.claude-rc for a managed linux target", async () => {
  await fillManaged("linux");
  expect(keyFileInput()!.value).toBe("");
  expect(keyFileInput()!.placeholder).toBe("authorized_keys.claude-rc");
  expect(flatText()).toContain(LINUX_HELP);
  expect(flatText()).toContain(DROPIN_HELP);
  expect(flatText()).toContain(RETIRE_HELP);
  expect(document.querySelector("form code")?.textContent).toBe("sudo claude-rc node sshd install");
  expect(flatText()).not.toContain("Use another file when a job rewrites authorized_keys.");
});

test("the key file field shows authorized_keys for a managed synology target", async () => {
  await fillManaged("synology");
  expect(keyFileInput()!.placeholder).toBe("authorized_keys");
  expect(flatText()).toContain("Use another file when a job rewrites authorized_keys.");
  expect(flatText()).not.toContain(LINUX_HELP);
  expect(flatText()).not.toContain(DROPIN_HELP);
});

test("an empty key file field sends no keyFile", async () => {
  await fillManaged("linux");
  press("Create target");
  await waitText("Step 2 of 6");
  expect(posts()[0]!.body).toEqual({
    id: "box",
    account: "admin",
    systemType: "linux",
    nodes: ["node1"],
    managedHost: "node2",
  });
});

const SKIPPED_NOTE = "The node did not check that sshd reads the key file. It is not root, or its version is older.";

test("the install step shows a note when the node skipped the sshd check", async () => {
  answers["POST /api/ssh/targets/nas/authorize"] = () => ({ body: { ok: true, sshdCheck: "skipped" } });
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, managedHost: "node1", systemType: "linux" });
  expect(document.body.textContent).not.toContain(SKIPPED_NOTE);
  press("Install on the node");
  await waitText("Step 5 of 6: Test");
  expect(document.querySelector("[data-sshd-note]")?.textContent?.trim()).toBe(SKIPPED_NOTE);
});

test("the install step shows no note when the node passed the sshd check", async () => {
  answers["POST /api/ssh/targets/nas/authorize"] = () => ({ body: { ok: true, sshdCheck: "passed" } });
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, managedHost: "node1", systemType: "linux" });
  press("Install on the node");
  await waitText("Step 5 of 6: Test");
  expect(document.querySelector("[data-sshd-note]")).toBeNull();
  expect(document.body.textContent).not.toContain(SKIPPED_NOTE);
});

test("a failed install shows the node text with the sshd command", async () => {
  const text =
    "sshd does not read ~/.ssh/authorized_keys.claude-rc for root. Run on this machine: sudo claude-rc node sshd install";
  answers["POST /api/ssh/targets/nas/authorize"] = () => ({ status: 502, body: { error: text } });
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, managedHost: "node1", systemType: "linux" });
  press("Install on the node");
  await waitText(text);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("sudo claude-rc node sshd install");
  expect(document.body.textContent).toContain("Step 4 of 6: Install");
  expect(document.querySelector("[data-sshd-note]")).toBeNull();
});

const fillManaged = async (type: string) => {
  answers["GET /api/hosts"] = () => ({ body: [{ id: "node2", name: "Box", status: "ok" }] });
  answers["POST /api/ssh/targets"] = () => ({ body: detail({ managedHost: "node2" }) });
  show(PRF);
  label("Managed").querySelector<HTMLElement>('[role="radio"]')!.click();
  flushSync();
  typeInto('input[id$="-id"]', "box");
  await pick('[id$="-host"]', "node2");
  await pick('[id$="-type"]', type);
  typeInto('input[id$="-account"]', "admin");
  label("node1").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
};

test("a managed linux target posts the key file that was typed", async () => {
  await fillManaged("linux");
  typeInto('input[id$="-keyfile"]', " authorized_keys2 ");
  press("Create target");
  await waitText("Step 2 of 6");
  expect(posts()[0]!.body).toEqual({
    id: "box",
    account: "admin",
    systemType: "linux",
    nodes: ["node1"],
    managedHost: "node2",
    keyFile: "authorized_keys2",
  });
});

test("an empty key file is not posted", async () => {
  await fillManaged("synology");
  press("Create target");
  await waitText("Step 2 of 6");
  expect(posts()[0]!.body).not.toHaveProperty("keyFile");
});

test("a key file typed for linux is not posted after the type changes to windows", async () => {
  await fillManaged("linux");
  typeInto('input[id$="-keyfile"]', "authorized_keys2");
  await pick('[id$="-type"]', "windows");
  press("Create target");
  await waitText("Step 2 of 6");
  expect(posts()[0]!.body).not.toHaveProperty("keyFile");
});

const pickLocal = async (status: SshStatus) => {
  answers["GET /api/hosts"] = () => ({ body: [{ id: "local", name: "Hub", status: "ok" }] });
  show(status);
  label("Managed").querySelector<HTMLElement>('[role="radio"]')!.click();
  flushSync();
  typeInto('input[id$="-id"]', "hubhost");
  await pick('[id$="-host"]', "local");
  typeInto('input[id$="-account"]', "root");
  label("node1").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
};

test("a managed target of local prefills the address from the source address of the node local", async () => {
  answers["POST /api/ssh/targets"] = () => ({ body: detail({ managedHost: "local" }) });
  await pickLocal({ ...PRF, nodes: [...PRF.nodes, { host: "local", enabled: false, sourceAddress: "192.168.1.5" }] });
  expect(document.querySelector<HTMLInputElement>('input[id$="-address"]')!.value).toBe("192.168.1.5");
  expect(document.body.textContent).toContain("LAN address of this machine as the other nodes see it");
  press("Create target");
  await waitText("Step 2 of 6");
  expect(posts()[0]!.body).toMatchObject({ managedHost: "local", address: "192.168.1.5" });
});

test("Choose a host takes the host back and the fill of the address of local with it", async () => {
  await pickLocal({ ...PRF, nodes: [...PRF.nodes, { host: "local", enabled: true, sourceAddress: "192.168.1.5" }] });
  const address = () => document.querySelector<HTMLInputElement>('input[id$="-address"]')!.value;
  expect(address()).toBe("192.168.1.5");
  const trigger = document.querySelector<HTMLElement>('[id$="-host"]')!;
  expect(trigger.labels[0]?.textContent).toBe("Managed host");
  await pick('[id$="-host"]', "");
  expect(trigger.textContent?.trim()).toBe("Choose a host");
  expect(address()).toBe("");
  expect(button("Create target")!.disabled).toBe(true);
});

test("a managed target of local needs an address when the node local has no source address", async () => {
  await pickLocal(PRF);
  expect(document.querySelector<HTMLInputElement>('input[id$="-address"]')!.value).toBe("");
  expect(button("Create target")!.disabled).toBe(true);
  typeInto('input[id$="-address"]', "192.168.1.9");
  expect(button("Create target")!.disabled).toBe(false);
});

const toTest = (extra: Partial<TargetDetail> = {}, status = PRF) =>
  resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, ...extra }, status).then((client) => {
    press("I installed it");
    return client;
  });

test("a failed test shows the ssh error text and keeps the target in draft", async () => {
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: false, error: "Permission denied (publickey)" } });
  await toTest();
  expect(document.body.textContent).toContain("Step 5 of 6: Test");
  press("Test connection");
  await waitText("Permission denied (publickey)");
  expect(document.body.textContent).not.toContain("is ready");
  expect(document.body.textContent).toContain("Step 5 of 6: Test");
  expect(button("Try again")).toBeDefined();
  expect(calls.some((call) => call.method === "PATCH")).toBe(false);
});

test("a passed test shows ready", async () => {
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: true } });
  await toTest();
  press("Test connection");
  await waitText("nas is ready");
  const test = posts().find((call) => call.url.endsWith("/test"))!;
  expect(test.body).toEqual({ node: "node1", unlock: { method: "prf", secret: "c2VjcmV0" } });
});

test("the test step asks for a new unlock every time", async () => {
  prf.unlockWithPasskey.mockResolvedValueOnce("Zmlyc3Q").mockResolvedValueOnce("c2Vjb25k");
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: false, error: "nope" } });
  await toTest({ nodes: ["node1", "node2"] }, BOTH);
  await pick('[id$="-test-node"]', "node2");
  press("Test connection");
  await waitText("nope");
  press("Try again");
  await vi.waitFor(() => expect(posts().filter((call) => call.url.endsWith("/test"))).toHaveLength(2));
  expect(prf.unlockWithPasskey).toHaveBeenCalledTimes(2);
  const sent = posts().filter((call) => call.url.endsWith("/test"));
  expect(sent[0]!.body).toEqual({ node: "node2", unlock: { method: "prf", secret: "Zmlyc3Q" } });
  expect(sent[1]!.body).toEqual({ node: "node2", unlock: { method: "prf", secret: "c2Vjb25k" } });
  // One salt call for each unlock.
  expect(calls.filter((call) => call.url.endsWith("/salt"))).toHaveLength(2);
});

test("the passphrase is not in the DOM or in storage after a call", async () => {
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: false, error: "nope" } });
  const client = await toTest({}, PASSPHRASE);
  typeInto('input[type="password"]', PASS);
  press("Test connection");
  await waitText("nope");
  const sent = posts().find((call) => call.url.endsWith("/test"))!;
  const secret = (sent.body as { unlock: { method: string; secret: string } }).unlock;
  expect(secret.method).toBe("passphrase");
  expect(Buffer.from(secret.secret, "base64url").toString()).toBe(PASS);
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(document.body.innerHTML).not.toContain(PASS);
  expect(document.body.innerHTML).not.toContain(secret.secret);
  for (const store of [localStorage, sessionStorage]) expect(JSON.stringify({ ...store })).not.toContain(PASS);
  const cached = JSON.stringify([
    ...client
      .getQueryCache()
      .getAll()
      .map((entry) => entry.state.data),
    ...client
      .getMutationCache()
      .getAll()
      .map((entry) => [entry.state.data, entry.state.variables]),
  ]);
  expect(cached).not.toContain(secret.secret);
  expect(cached).not.toContain(PASS);
  // A second call needs the passphrase typed again.
  press("Try again");
  await waitText("Type the passphrase.");
  expect(posts().filter((call) => call.url.endsWith("/test"))).toHaveLength(1);
});

test("the key call keeps no secret in the mutation cache", async () => {
  answers["POST /api/ssh/targets/nas/key"] = () => ({ body: { ...KEY_ANSWER, notes: [] } });
  const client = await resumeAt({}, PASSPHRASE);
  typeInto('input[type="password"]', PASS);
  press("Create key");
  await waitText("Step 3 of 6");
  const sent = posts().find((call) => call.url.endsWith("/key"))!;
  expect(sent.body).toEqual({ unlock: { method: "passphrase", secret: Buffer.from(PASS).toString("base64url") } });
  expect(document.body.innerHTML).not.toContain(PASS);
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((entry) => entry.state.variables),
    ),
  ).not.toContain(Buffer.from(PASS).toString("base64url"));
});

test("a failed refetch of the target does not move or unmount the step", async () => {
  answers["POST /api/ssh/targets/nas/scan"] = () => ({ body: { keys: [{ line: ED, fingerprint: "SHA256:ed" }] } });
  const client = await resumeAt({ keyFingerprint: "SHA256:key" });
  press("Scan host key");
  await waitText("SHA256:ed");
  label("They match").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  answers["GET /api/ssh/targets/nas"] = () => ({ status: 500, body: { error: "boom" } });
  await client.refetchQueries({ queryKey: ["ssh", "target", "nas"] });
  flushSync();
  expect(client.getQueryState(["ssh", "target", "nas"])?.status).toBe("error");
  expect(document.body.textContent).toContain("SHA256:ed");
  expect(label("They match").querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("true");
  expect(button("Pin host key")!.disabled).toBe(false);
});

test("Cancel calls onclose", () => {
  show(PRF);
  press("Cancel");
  expect(closed).toBe(1);
});

test("the node select shows the node that the scan uses when the admin does not touch it", async () => {
  answers["POST /api/ssh/targets/nas/scan"] = () => ({ body: { keys: [{ line: ED, fingerprint: "SHA256:ed" }] } });
  await resumeAt({ keyFingerprint: "SHA256:key", nodes: ["node1", "node2"] }, BOTH);
  const select = document.querySelector<HTMLElement>('[id$="-scan-node"]')!;
  expect(select.labels[0]?.textContent).toBe("Read the host key from this node");
  expect(select.textContent?.trim()).toBe("node1");
  press("Scan host key");
  await waitText("SHA256:ed");
  expect(posts().find((call) => call.url.endsWith("/scan"))!.body).toEqual({ node: "node1" });
});

test("the node select of the test step shows the node that the test uses", async () => {
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: true } });
  await toTest({ nodes: ["node1", "node2"] }, BOTH);
  const select = document.querySelector<HTMLElement>('[id$="-test-node"]')!;
  expect(select.labels[0]?.textContent).toBe("Run the test from this node");
  expect(select.textContent?.trim()).toBe("node1");
  press("Test connection");
  await waitText("nas is ready");
  expect(posts().find((call) => call.url.endsWith("/test"))!.body).toMatchObject({ node: "node1" });
});

const checkUsername = () => {
  const users = document.querySelectorAll<HTMLInputElement>('input[autocomplete="username"]');
  expect(users).toHaveLength(1);
  expect(users[0]!.hidden).toBe(false);
  expect(users[0]!.value).toBe("claude-rc-ssh");
  expect(users[0]!.classList.contains("sr-only")).toBe(true);
};

test("the first key of the hub asks for a new password, with the rule and a user name field", async () => {
  await resumeAt({}, { ...PASSPHRASE, hasKeys: false });
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(field.autocomplete).toBe("new-password");
  expect(field.name).toBe("claude-rc-ssh-passphrase");
  expect(document.body.textContent).toContain("at least 12 characters");
  checkUsername();
});

test("a later key asks for the current password", async () => {
  await resumeAt({}, { ...PASSPHRASE, hasKeys: true });
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.autocomplete).toBe("current-password");
  expect(document.body.textContent).not.toContain("at least 12 characters");
  checkUsername();
});

test("the first key is not sent with 11 characters and is sent with 12", async () => {
  answers["POST /api/ssh/targets/nas/key"] = () => ({ body: { ...KEY_ANSWER, notes: [] } });
  await resumeAt({}, { ...PASSPHRASE, hasKeys: false });
  typeInto('input[type="password"]', "elevenchars");
  press("Create key");
  await waitText("The passphrase needs at least 12 characters.");
  expect(posts().filter((call) => call.url.endsWith("/key"))).toHaveLength(0);
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("elevenchars");
  typeInto('input[type="password"]', "twelve chars");
  press("Create key");
  await waitText("Step 3 of 6");
  expect(posts().filter((call) => call.url.endsWith("/key"))).toHaveLength(1);
});

test("the test step asks for the current password even when the status says no key", async () => {
  await toTest({}, { ...PASSPHRASE, hasKeys: false });
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.autocomplete).toBe("current-password");
  checkUsername();
});

test("the target form fields keep autocomplete off", () => {
  show(PASSPHRASE);
  const fields = document.querySelectorAll<HTMLInputElement>(
    "input[type='text'], input:not([type]), input[type='number']",
  );
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) expect(field.autocomplete).toBe("off");
});

test("a status without hasKeys asks for the current password and shows no rule", async () => {
  await resumeAt({}, PASSPHRASE);
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.autocomplete).toBe("current-password");
  expect(document.body.textContent).not.toContain("at least 12 characters");
});

test("the wizard of an external target names the provisioner command", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, state: "ready" });
  const hint = document.querySelector("[data-provisioner-hint]")!;
  expect(hint.textContent!.replace(/\s+/g, " ")).toContain("claude-rc ssh target provisioner nas --identity <file>");
});

test("the wizard of an external dropbear target names the provisioner command too", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, state: "ready", systemType: "dropbear" });
  expect(document.querySelector("[data-provisioner-hint]")).not.toBeNull();
});

test.each([
  ["a managed target", { managedHost: "node1" }],
  ["a windows target", { systemType: "windows" as const }],
  ["a target that has a provisioner", { provisionerFingerprint: "SHA256:prov" }],
])("the done screen of %s names no provisioner command", async (_name, extra) => {
  await resumeAt({ keyFingerprint: "SHA256:key", hostKey: ED, state: "ready", ...extra });
  expect(document.body.textContent).toContain("is ready");
  expect(document.querySelector("[data-provisioner-hint]")).toBeNull();
});

test("the test step says what the test does", async () => {
  await toTest();
  const text = document.body.textContent!.replace(/\s+/g, " ");
  expect(text).toContain("A test connects to the target from the node you choose.");
  expect(text).toContain("The address of that node must be allowed for this target.");
  expect(text).toContain("The test opens a connection for one minute and needs a new unlock.");
  expect(text).toContain("A failed test leaves the target in draft.");
});

test("the node list leaves out a node with access off or no source address, and keeps the order", async () => {
  const status: SshStatus = {
    ...PRF,
    nodes: [
      { host: "node1", enabled: true, sourceAddress: "10.0.0.2" },
      { host: "node2", enabled: false, sourceAddress: "10.0.0.3" },
      { host: "node3", enabled: true, sourceAddress: "" },
      { host: "node4", enabled: true, sourceAddress: "10.0.0.5" },
    ],
  };
  await toTest({ nodes: ["node4", "node3", "node2", "node1"] }, status);
  const trigger = document.querySelector<HTMLElement>('[id$="-test-node"]')!;
  expect(trigger.textContent?.trim()).toBe("node4");
  await openSelect(trigger);
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((item) => item.dataset.value);
  expect(options).toEqual(["node4", "node1"]);
});

test("one node left shows no selector and the requests use it", async () => {
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: true } });
  answers["POST /api/ssh/targets/nas/scan"] = () => ({ body: { keys: [{ line: ED, fingerprint: "SHA256:ed" }] } });
  await resumeAt({ keyFingerprint: "SHA256:key", nodes: ["node2", "node1"] });
  expect(document.querySelector('[id$="-scan-node"]')).toBeNull();
  press("Scan host key");
  await waitText("SHA256:ed");
  expect(posts().find((call) => call.url.endsWith("/scan"))!.body).toEqual({ node: "node1" });
  label("They match").querySelector<HTMLElement>('[role="checkbox"]')!.click();
  flushSync();
  answers["POST /api/ssh/targets/nas/pin"] = () => ({ body: detail({ hostKey: ED }) });
  press("Pin host key");
  await waitText("Step 4 of 6");
  press("I installed it");
  expect(document.querySelector('[id$="-test-node"]')).toBeNull();
  press("Test connection");
  await waitText("nas is ready");
  expect(posts().find((call) => call.url.endsWith("/test"))!.body).toMatchObject({ node: "node1" });
});

test("no node left at the host key step shows the message and disables the scan", async () => {
  await resumeAt({ keyFingerprint: "SHA256:key", nodes: ["node2"] });
  expect(document.body.textContent).toContain(NO_NODE);
  expect(document.querySelector('[id$="-scan-node"]')).toBeNull();
  expect(button("Scan host key")!.disabled).toBe(true);
});

test("no node left at the test step shows the message and disables the test", async () => {
  await toTest({ nodes: ["node2"] });
  expect(document.body.textContent).toContain(NO_NODE);
  expect(document.querySelector('[id$="-test-node"]')).toBeNull();
  expect(button("Test connection")!.disabled).toBe(true);
});
