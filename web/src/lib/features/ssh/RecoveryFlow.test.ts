// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { SshStatus } from "./api";
import RecoveryFlowHarness from "./RecoveryFlowHarness.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));
import { UnlockError } from "./prf";

type Call = { method: string; url: string; body: unknown };
const CODE = "ABCD-EFGH-IJKL-MNOP";
const PASS = "correct horse battery";
const PASS_B64 = Buffer.from(PASS).toString("base64url");
const STATUS: SshStatus = { setUp: true, method: "passphrase", pendingRewrap: [], nodes: [] };

let calls: Call[];
let answers: Record<string, { status: number; body: unknown }>;
let closed: number;
const open: Array<() => void> = [];

beforeEach(() => {
  calls = [];
  closed = 0;
  answers = { "POST /api/ssh/recovery/begin": { status: 200, body: { targets: ["nas", "web"] } } };
  prf.registerPasskey.mockReset();
  prf.unlockWithPasskey.mockReset();
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true, proved: true });
  prf.unlockWithPasskey.mockResolvedValue("bmV3c2VjcmV0");
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const found = answers[`${method} ${path}`];
    if (found)
      return new Response(JSON.stringify(found.body), {
        status: found.status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/salt"))
      return new Response(JSON.stringify({ salt: `salt-of-${path.split("/")[4]}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/rewrap")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

function show(status: SshStatus = STATUS, client = createQueryClient()) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(RecoveryFlowHarness, { target, props: { client, status, onclose: () => closed++ } });
  open.push(() => unmount(mounted));
  flushSync();
  return client;
}

const buttons = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.trim() === label);
const button = (label: string) => buttons(label)[0]!;

const press = (label: string) => {
  button(label).click();
  flushSync();
};

const type = (selector: string, text: string) => {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

const pick = (value: string) => {
  document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!.click();
  flushSync();
};

const typeCode = () => type('input[type="text"]', CODE);

const typePassphrases = (first = PASS, second = PASS) => {
  const fields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');

  for (const [index, text] of [first, second].entries()) {
    fields[index]!.value = text;
    fields[index]!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  flushSync();
};

const waitText = (text: string) => vi.waitFor(() => expect(document.body.textContent).toContain(text));
const posts = (suffix: string) => calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix));

async function toRelock(method: "prf" | "passphrase") {
  show();
  typeCode();
  pick(method);
  if (method === "passphrase") typePassphrases();
  press("Continue");
  await waitText("Each target needs one re-lock");
}

test("the recovery step sends the code, the new method and the credential id to the begin route", async () => {
  show();
  typeCode();
  press("Continue");
  await waitText("Each target needs one re-lock");
  expect(prf.registerPasskey).toHaveBeenCalledTimes(1);
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(posts("/recovery/begin")).toEqual([
    {
      method: "POST",
      url: "/api/ssh/recovery/begin",
      body: { code: CODE, method: "prf", credentialId: "newcred" },
    },
  ]);

  document.body.innerHTML = "";
  calls = [];
  show();
  typeCode();
  pick("passphrase");
  typePassphrases();
  press("Continue");
  await waitText("Each target needs one re-lock");
  expect(posts("/recovery/begin")[0]!.body).toEqual({ code: CODE, method: "passphrase" });
});

const HINT = "If the phone showed no passkey to pick, wait a few seconds and try again.";

test("a passkey with PRF enabled but no secret waits for a separate tap before the begin call", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true, proved: false });
  show();
  typeCode();
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(calls).toEqual([]);

  press("Test your passkey");
  await waitText("Each target needs one re-lock");
  const [credential, salt] = prf.unlockWithPasskey.mock.calls[0]!;
  expect(credential).toBe("newcred");
  expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(posts("/recovery/begin")[0]!.body).toEqual({ code: CODE, method: "prf", credentialId: "newcred" });
});

test("a failed passkey test shows the message and the hint, keeps the button and the passphrase offer", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true, proved: false });
  prf.unlockWithPasskey.mockRejectedValueOnce(new UnlockError("The passkey prompt was cancelled"));
  show();
  typeCode();
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  press("Test your passkey");
  await waitText("The passkey prompt was cancelled");
  expect(document.body.textContent).toContain(HINT);
  expect(calls).toEqual([]);
  expect(button("Test your passkey")).toBeDefined();
  expect(button("Use a passphrase instead")).toBeDefined();

  press("Test your passkey");
  await waitText("Each target needs one re-lock");
  expect(prf.registerPasskey).toHaveBeenCalledTimes(1);
});

test("switching to the passphrase after an unproven passkey brings Continue and its checks back", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true, proved: false });
  show();
  typeCode();
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  pick("passphrase");
  expect(buttons("Test your passkey")).toHaveLength(0);
  expect(document.body.textContent).not.toContain("Tap to test the passkey");
  typePassphrases(PASS, "other");
  press("Continue");
  await waitText("The two passphrases do not match.");
  typePassphrases();
  press("Continue");
  await waitText("Each target needs one re-lock");
  expect(posts("/recovery/begin")[0]!.body).toEqual({ code: CODE, method: "passphrase" });
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
});

test("the test button with an empty code does not prompt and shows the empty-code message", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true, proved: false });
  show();
  typeCode();
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  type('input[type="text"]', "");
  press("Test your passkey");
  await waitText("Type the recovery code.");
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
  expect(buttons("Test your passkey")).toHaveLength(1);
});

test("the passphrase offer after a failed passkey test works", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true, proved: false });
  prf.unlockWithPasskey.mockRejectedValue(new UnlockError("This passkey does not return a PRF secret"));
  show();
  typeCode();
  press("Continue");
  await waitText("Tap to test the passkey you just created.");
  press("Test your passkey");
  await waitText("This passkey does not return a PRF secret");
  press("Use a passphrase instead");
  expect(buttons("Test your passkey")).toHaveLength(0);
  typePassphrases();
  press("Continue");
  await waitText("Each target needs one re-lock");
  expect(posts("/recovery/begin")[0]!.body).toEqual({ code: CODE, method: "passphrase" });
});

test("a wrong recovery code shows the message and stays on the first step", async () => {
  answers["POST /api/ssh/recovery/begin"] = { status: 403, body: { error: "wrong recovery code" } };
  show();
  typeCode();
  press("Continue");
  await waitText("The recovery code does not belong to this hub.");
  expect(document.body.textContent).not.toContain("Each target needs one re-lock");
  expect(button("Continue").disabled).toBe(false);

  answers["POST /api/ssh/recovery/begin"] = { status: 200, body: { targets: ["nas"] } };
  press("Continue");
  await waitText("Each target needs one re-lock");
  // The passkey that passed the test is reused, not registered again.
  expect(prf.registerPasskey).toHaveBeenCalledTimes(1);
  expect(posts("/recovery/begin")[1]!.body).toEqual({ code: CODE, method: "prf", credentialId: "newcred" });
});

test("a passkey without PRF shows the message and offers the passphrase", async () => {
  prf.registerPasskey.mockResolvedValue({ credentialId: "weak", prf: false, proved: false });
  show();
  typeCode();
  press("Continue");
  await waitText("does not support the PRF extension");
  expect(prf.unlockWithPasskey).not.toHaveBeenCalled();
  expect(calls).toEqual([]);

  press("Use a passphrase instead");
  expect(document.querySelectorAll('input[type="password"]')).toHaveLength(2);
  typePassphrases();
  press("Continue");
  await waitText("Each target needs one re-lock");
  expect(posts("/recovery/begin")[0]!.body).toEqual({ code: CODE, method: "passphrase" });
});

test("the passphrase must be typed twice and the two must match", async () => {
  show();
  typeCode();
  pick("passphrase");
  typePassphrases(PASS, "correct horse batter");
  press("Continue");
  await waitText("The two passphrases do not match.");
  expect(calls).toEqual([]);

  typePassphrases("", "");
  press("Continue");
  await waitText("Type the new passphrase.");
  expect(calls).toEqual([]);

  typePassphrases(PASS, PASS);
  press("Continue");
  await waitText("Each target needs one re-lock");
  expect(posts("/recovery/begin")).toHaveLength(1);
});

test("each pending target gets a Re-lock button that sends the code and a new unlock to its rewrap route", async () => {
  await toRelock("passphrase");
  expect(buttons("Re-lock")).toHaveLength(2);
  expect(document.body.textContent).toContain("nas");
  expect(document.body.textContent).toContain("web");

  buttons("Re-lock")[0]!.click();
  await waitText("Done");
  expect(posts("/rewrap")).toEqual([
    {
      method: "POST",
      url: "/api/ssh/targets/nas/rewrap",
      body: { code: CODE, unlock: { method: "passphrase", secret: PASS_B64 } },
    },
  ]);
  expect(buttons("Re-lock")).toHaveLength(1);
});

test("the salt of the target is fetched and used for the unlock of that target", async () => {
  await toRelock("prf");
  const relock = document.querySelector<HTMLButtonElement>('button[aria-label="Re-lock web"]')!;
  relock.click();
  await waitText("Done");
  expect(calls.filter((call) => call.url.endsWith("/salt")).map((call) => call.url)).toEqual([
    "/api/ssh/targets/web/salt",
  ]);
  expect(prf.unlockWithPasskey).toHaveBeenLastCalledWith("newcred", "salt-of-web");
  expect(posts("/rewrap")).toEqual([
    {
      method: "POST",
      url: "/api/ssh/targets/web/rewrap",
      body: { code: CODE, unlock: { method: "prf", secret: "bmV3c2VjcmV0" } },
    },
  ]);
});

test("recovery is complete when every target is re-locked", async () => {
  await toRelock("passphrase");
  expect(document.body.textContent).not.toContain("Recovery is complete.");
  buttons("Re-lock")[0]!.click();
  await vi.waitFor(() => expect(buttons("Re-lock")).toHaveLength(1));
  buttons("Re-lock")[0]!.click();
  await waitText("Recovery is complete.");
  expect(posts("/rewrap")).toHaveLength(2);
  expect(buttons("Re-lock")).toHaveLength(0);
  press("Close");
  expect(closed).toBe(1);
});

test("a failed re-lock shows its message and keeps the button", async () => {
  answers["POST /api/ssh/targets/nas/rewrap"] = { status: 409, body: { error: "this target does not need a re-wrap" } };
  await toRelock("passphrase");
  buttons("Re-lock")[0]!.click();
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("this target does not need a re-wrap"),
  );
  expect(buttons("Re-lock")).toHaveLength(2);
});

test("the recovery code and the passphrase are not in the DOM, storage or caches after the flow closes", async () => {
  const client = show();
  typeCode();
  pick("passphrase");
  typePassphrases();
  press("Continue");
  await waitText("Each target needs one re-lock");
  buttons("Re-lock")[0]!.click();
  await waitText("Done");
  const secrets = [CODE, "ABCD", PASS, PASS_B64];
  const seen = () =>
    [
      document.body.innerHTML,
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
      location.href,
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((entry) => [entry.queryKey, entry.state.data]),
      ),
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((entry) => [entry.state.data, entry.state.variables]),
      ),
    ].join("\n");
  expect(client.getMutationCache().getAll()).toEqual([]);

  press("Close");
  await vi.waitFor(() => expect(closed).toBe(1));
  for (const secret of secrets) expect(seen()).not.toContain(secret);
});

test("Cancel on the first step closes the flow without a call", () => {
  show();
  typeCode();
  press("Cancel");
  expect(closed).toBe(1);
  expect(calls).toEqual([]);
});

test("both new passphrase fields are new passwords, the code field stays off, and one user name field exists", () => {
  show();
  typeCode();
  const code = document.querySelector<HTMLInputElement>('input[type="text"]')!;
  expect(code.autocomplete).toBe("off");
  expect(code.getAttribute("spellcheck")).toBe("false");
  pick("passphrase");
  const fields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
  expect(fields).toHaveLength(2);
  for (const field of fields) expect(field.autocomplete).toBe("new-password");
  expect(fields[0]!.name).toBe("claude-rc-ssh-passphrase");
  const users = document.querySelectorAll<HTMLInputElement>('input[autocomplete="username"]');
  expect(users).toHaveLength(1);
  expect(users[0]!.hidden).toBe(false);
  expect(document.body.textContent).toContain("at least 12 characters");
});

test("a passphrase of 11 characters is refused before any call and 12 is sent", async () => {
  show();
  typeCode();
  pick("passphrase");
  typePassphrases("elevenchars", "elevenchars");
  press("Continue");
  await waitText("The passphrase needs at least 12 characters.");
  expect(calls).toEqual([]);
  typePassphrases("twelve chars", "twelve chars");
  press("Continue");
  await waitText("Each target needs one re-lock");
});

test("sending the form from the confirmation field continues, so a manager can save the passphrase", async () => {
  show();
  typeCode();
  pick("passphrase");
  typePassphrases();
  const again = document.querySelectorAll<HTMLInputElement>('input[type="password"]')[1]!;
  const form = again.closest("form")!;
  expect(form).not.toBeNull();
  expect(form.querySelector('input[type="password"]')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>(`button[form="${form.id}"][type="submit"]`)?.textContent).toContain(
    "Continue",
  );
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await waitText("Each target needs one re-lock");
});

test("a leading byte order mark is not counted, as the hub decodes it away", async () => {
  show();
  typeCode();
  pick("passphrase");
  typePassphrases("﻿elevenchars", "﻿elevenchars");
  press("Continue");
  await waitText("The passphrase needs at least 12 characters.");
  expect(calls).toEqual([]);
  typePassphrases("﻿twelve chars", "﻿twelve chars");
  press("Continue");
  await waitText("Each target needs one re-lock");
});

test("the recovery flow lists a re-lock row for each provisioner key", async () => {
  answers["GET /api/ssh/status"] = {
    status: 200,
    body: { ...STATUS, pendingRewrap: ["nas"], pendingProvisionerRewrap: ["nas"] },
  };
  answers["POST /api/ssh/recovery/begin"] = { status: 200, body: { targets: ["nas"] } };
  await toRelock("passphrase");
  expect(buttons("Re-lock")).toHaveLength(2);
  expect(document.body.textContent).toContain("provisioner key");
  document.querySelector<HTMLButtonElement>('button[aria-label="Re-lock the provisioner key of nas"]')!.click();
  await waitText("Done");
  expect(posts("/rewrap")).toEqual([
    {
      method: "POST",
      url: "/api/ssh/targets/nas/rewrap",
      body: { code: CODE, unlock: { method: "passphrase", secret: PASS_B64 }, key: "provisioner" },
    },
  ]);
  expect(buttons("Re-lock")).toHaveLength(1);
  buttons("Re-lock")[0]!.click();
  await waitText("Recovery is complete.");
});

test("a provisioner key with a passkey asks for the provisioner salt", async () => {
  answers["GET /api/ssh/status"] = { status: 200, body: { ...STATUS, pendingProvisionerRewrap: ["web"] } };
  answers["POST /api/ssh/recovery/begin"] = { status: 200, body: { targets: [] } };
  show();
  typeCode();
  pick("prf");
  press("Continue");
  await waitText("Each target needs one re-lock");
  document.querySelector<HTMLButtonElement>('button[aria-label="Re-lock the provisioner key of web"]')!.click();
  await waitText("Done");
  expect(calls.filter((call) => call.url.includes("/salt")).map((call) => call.url)).toEqual([
    "/api/ssh/targets/web/salt?key=provisioner",
  ]);
});
