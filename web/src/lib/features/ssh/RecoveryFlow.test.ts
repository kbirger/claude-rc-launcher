// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { SshStatus } from "./api";
import RecoveryFlowHarness from "./RecoveryFlowHarness.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));

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
  prf.registerPasskey.mockResolvedValue({ credentialId: "newcred", prf: true });
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
  const [credential, salt] = prf.unlockWithPasskey.mock.calls[0]!;
  expect(credential).toBe("newcred");
  expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
  prf.registerPasskey.mockResolvedValue({ credentialId: "weak", prf: false });
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
