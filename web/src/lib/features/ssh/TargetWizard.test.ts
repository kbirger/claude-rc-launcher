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

const choose = (selector: string, value: string) => {
  const select = document.querySelector<HTMLSelectElement>(selector)!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
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
  label("node1").querySelector("input")!.click();
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

  label("They match").querySelector("input")!.click();
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
  label("They match").querySelector("input")!.click();
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
  label("They match").querySelector("input")!.click();
  flushSync();
  press("Pin host key");
  await waitText("Step 4 of 6");
  expect(document.querySelector("code")!.textContent!.trim()).toBe(LINE);
  expect(document.body.textContent).toContain("Fresh note");
  press("Copy");
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(LINE));
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

test("the type list holds linux, windows, synology and dropbear and nothing else", () => {
  show(PRF);
  const options = [...document.querySelectorAll<HTMLOptionElement>('select[id$="-type"] option')].map(
    (item) => item.value,
  );
  expect(options).toEqual(["linux", "windows", "synology", "dropbear"]);
});

test("the form lists only the nodes with SSH access on, none checked, and checks the id", () => {
  show(PRF);
  const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map((box) => box.value)).toEqual(["node1"]);
  expect(boxes[0]!.checked).toBe(false);
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
  label("Managed").querySelector("input")!.click();
  flushSync();
  await vi.waitFor(() => expect(document.querySelector('select[id$="-host"] option[value="node2"]')).not.toBeNull());
  typeInto('input[id$="-id"]', "box");
  choose('select[id$="-host"]', "node2");
  choose('select[id$="-type"]', "windows");
  typeInto('input[id$="-account"]', "admin");
  label("node1").querySelector("input")!.click();
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

const pickLocal = async (status: SshStatus) => {
  answers["GET /api/hosts"] = () => ({ body: [{ id: "local", name: "Hub", status: "ok" }] });
  show(status);
  label("Managed").querySelector("input")!.click();
  flushSync();
  await vi.waitFor(() => expect(document.querySelector('select[id$="-host"] option[value="local"]')).not.toBeNull());
  typeInto('input[id$="-id"]', "hubhost");
  choose('select[id$="-host"]', "local");
  typeInto('input[id$="-account"]', "root");
  label("node1").querySelector("input")!.click();
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
  await toTest({ nodes: ["node1", "node2"] });
  choose('select[id$="-test-node"]', "node2");
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
  label("They match").querySelector("input")!.click();
  flushSync();
  answers["GET /api/ssh/targets/nas"] = () => ({ status: 500, body: { error: "boom" } });
  await client.refetchQueries({ queryKey: ["ssh", "target", "nas"] });
  flushSync();
  expect(client.getQueryState(["ssh", "target", "nas"])?.status).toBe("error");
  expect(document.body.textContent).toContain("SHA256:ed");
  expect(label("They match").querySelector("input")!.checked).toBe(true);
  expect(button("Pin host key")!.disabled).toBe(false);
});

test("Cancel calls onclose", () => {
  show(PRF);
  press("Cancel");
  expect(closed).toBe(1);
});

test("the node select shows the node that the scan uses when the admin does not touch it", async () => {
  answers["POST /api/ssh/targets/nas/scan"] = () => ({ body: { keys: [{ line: ED, fingerprint: "SHA256:ed" }] } });
  await resumeAt({ keyFingerprint: "SHA256:key", nodes: ["node1", "node2"] });
  const select = document.querySelector<HTMLSelectElement>('select[id$="-scan-node"]')!;
  expect(select.selectedIndex).toBe(0);
  expect(select.value).toBe("node1");
  press("Scan host key");
  await waitText("SHA256:ed");
  expect(posts().find((call) => call.url.endsWith("/scan"))!.body).toEqual({ node: "node1" });
});

test("the node select of the test step shows the node that the test uses", async () => {
  answers["POST /api/ssh/targets/nas/test"] = () => ({ body: { ok: true } });
  await toTest({ nodes: ["node1", "node2"] });
  const select = document.querySelector<HTMLSelectElement>('select[id$="-test-node"]')!;
  expect(select.selectedIndex).toBe(0);
  press("Test connection");
  await waitText("nas is ready");
  expect(posts().find((call) => call.url.endsWith("/test"))!.body).toMatchObject({ node: select.value });
  expect(select.value).toBe("node1");
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
