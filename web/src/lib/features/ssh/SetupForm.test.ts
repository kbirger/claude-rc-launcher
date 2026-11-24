// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import SetupFormHarness from "./SetupFormHarness.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));
import { UnlockError } from "./prf";

const CODE = "ABCD-EFGH-IJKL-MNOP";
let sent: { url: string; method: string; body: unknown }[] = [];
const open: Array<() => void> = [];

beforeEach(() => {
  sent = [];
  prf.registerPasskey.mockReset();
  prf.unlockWithPasskey.mockReset();
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = method === "POST" ? { recoveryCode: CODE } : { setUp: true, nodes: [] };
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

function show(client = createQueryClient()) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(SetupFormHarness, { target, props: { client } });
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

const pick = (value: string) => {
  const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  radio.click();
  flushSync();
};

const typeInto = (selector: string, text: string) => {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

const waitText = (text: string) => vi.waitFor(() => expect(document.body.textContent).toContain(text));
const posts = () => sent.filter((item) => item.method === "POST");

test("a passkey with no PRF shows the message and offers the passphrase", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: false, proved: false });
  show();
  pick("prf");
  press("Continue");
  await waitText("does not support the PRF extension");
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
  expect(button("Use a passphrase instead")).toBeDefined();

  press("Use a passphrase instead");
  await waitText(CODE);
  expect(posts()[0]!.body).toEqual({ method: "passphrase" });
});

const HINT = "If the phone showed no passkey to pick, wait a few seconds and try again.";

test("a passkey that returns a secret at creation continues at once without a second prompt", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: true, proved: true });
  show();
  pick("prf");
  press("Continue");
  await waitText(CODE);
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(button("Test your passkey")).toBeUndefined();
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!).toMatchObject({ url: "/api/ssh/setup", body: { method: "prf", credentialId: "cred" } });
  expect(document.body.textContent).toContain("Passkey created. It returns a PRF secret.");
});

test("a passkey with PRF enabled but no secret waits for a separate tap before it continues", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: true, proved: false });
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
  show();
  pick("prf");
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  expect(button("Test your passkey")).toBeDefined();
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(sent).toEqual([]);

  press("Test your passkey");
  await waitText(CODE);
  expect(prf.unlockWithPasskey).toHaveBeenCalledTimes(1);
  const [credential, salt] = prf.unlockWithPasskey.mock.calls[0]!;
  expect(credential).toBe("cred");
  expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(posts()[0]!).toMatchObject({ url: "/api/ssh/setup", body: { method: "prf", credentialId: "cred" } });
});

test("a failed test shows the message and the hint, keeps the button and the passphrase offer", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: true, proved: false });
  prf.unlockWithPasskey.mockRejectedValueOnce(new UnlockError("The passkey prompt was cancelled"));
  prf.unlockWithPasskey.mockResolvedValueOnce("c2VjcmV0");
  show();
  pick("prf");
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  press("Test your passkey");
  await waitText("The passkey prompt was cancelled");
  expect(document.body.textContent).toContain(HINT);
  expect(sent).toEqual([]);
  expect(button("Test your passkey")).toBeDefined();
  expect(button("Use a passphrase instead")).toBeDefined();

  press("Test your passkey");
  await waitText(CODE);
  expect(prf.unlockWithPasskey).toHaveBeenCalledTimes(2);
  expect(posts()).toHaveLength(1);
});

test("switching to the passphrase after an unproven passkey brings Continue back", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: true, proved: false });
  show();
  pick("prf");
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  pick("passphrase");
  expect(button("Test your passkey")).toBeUndefined();
  expect(document.body.textContent).not.toContain("Tap to test the passkey");
  press("Continue");
  await waitText(CODE);
  expect(posts()[0]!.body).toEqual({ method: "passphrase" });
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
});

test("the passphrase offer after a failed test works", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: true, proved: false });
  prf.unlockWithPasskey.mockRejectedValue(new UnlockError("This passkey does not return a PRF secret"));
  show();
  pick("prf");
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  press("Test your passkey");
  await waitText("This passkey does not return a PRF secret");
  press("Use a passphrase instead");
  await waitText(CODE);
  expect(posts()[0]!.body).toEqual({ method: "passphrase" });
});

test("the recovery code is shown once and the form asks for the first group back", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "cred", prf: true, proved: true });
  show();
  pick("prf");
  press("Continue");
  await waitText(CODE);
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!).toMatchObject({ url: "/api/ssh/setup", body: { method: "prf", credentialId: "cred" } });
  expect(document.querySelector("code")!.textContent).toBe(CODE);
  expect(document.querySelector("label[for]")!.textContent).toContain("first group");
  expect(document.querySelector('[data-testid="holding"]')!.textContent).toBe("yes");
});

test("the form refuses to finish until the group matches", async () => {
  show();
  pick("passphrase");
  press("Continue");
  await waitText(CODE);
  expect(button("Finish")!.disabled).toBe(true);
  typeInto("input[type=text]", "WXYZ");
  expect(button("Finish")!.disabled).toBe(true);
  typeInto("input[type=text]", " ab-cd ");
  expect(button("Finish")!.disabled).toBe(false);
});

test("the recovery code does not survive Finish", async () => {
  const client = show();
  pick("passphrase");
  press("Continue");
  await waitText(CODE);
  typeInto("input[type=text]", "abcd");
  press("Finish");
  await vi.waitFor(() => expect(document.body.textContent).not.toContain(CODE));
  expect(document.body.innerHTML).not.toContain("ABCD");
  expect(document.querySelector('[data-testid="holding"]')!.textContent).toBe("no");
  expect(document.body.textContent).toContain("SSH access is set up");
  for (const store of [localStorage, sessionStorage]) expect(JSON.stringify({ ...store })).not.toContain("ABCD");
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state.data),
    ),
  ).not.toContain("ABCD");
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((entry) => entry.state.data),
    ),
  ).not.toContain("ABCD");
});
