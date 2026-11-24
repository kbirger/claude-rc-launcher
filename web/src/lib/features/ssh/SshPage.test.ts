// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import SshPageHarness from "./SshPageHarness.svelte";
import { SSH_KEY } from "./queries";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));
import { UnlockError } from "./prf";

const CODE = "ABCD-EFGH-IJKL-MNOP";
let statusAnswer: { status: number; body: unknown };
const open: Array<() => void> = [];

beforeEach(() => {
  prf.unlockWithPasskey.mockReset();
  statusAnswer = { status: 200, body: { setUp: false, nodes: [] } };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const answer =
      init?.method === "POST"
        ? { status: 200, body: { recoveryCode: CODE } }
        : String(url) === "/api/ssh/grants"
          ? { status: 200, body: [] }
          : statusAnswer;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;

async function showCode() {
  const client = createQueryClient();
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(SshPageHarness, { target, props: { client } });
  open.push(() => unmount(mounted));
  await vi.waitFor(() => expect(document.body.textContent).toContain("SSH access setup"));
  document.querySelector<HTMLInputElement>('input[value="passphrase"]')!.click();
  flushSync();
  button("Continue").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain(CODE));
  return client;
}

test("a failed status refetch leaves the recovery code on screen", async () => {
  const client = await showCode();
  statusAnswer = { status: 500, body: { error: "boom" } };
  await client.refetchQueries({ queryKey: [...SSH_KEY, "status"] });
  flushSync();
  expect(client.getQueryState([...SSH_KEY, "status"])?.status).toBe("error");
  expect(document.body.textContent).toContain(CODE);
  expect(button("Finish")).toBeDefined();
});

test("a status refetch that says set up leaves the recovery code until Finish", async () => {
  const client = await showCode();
  statusAnswer = { status: 200, body: { setUp: true, method: "passphrase", nodes: [] } };
  await client.refetchQueries({ queryKey: [...SSH_KEY, "status"] });
  flushSync();
  expect(document.body.textContent).toContain(CODE);
});

const READY = {
  setUp: true,
  method: "passphrase",
  nodes: [{ host: "node1", enabled: true, sourceAddress: "10.0.0.2" }],
};

function showReady(props: { target?: string | null; onclose?: () => void } = {}) {
  statusAnswer = { status: 200, body: READY };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    const path = String(url);
    const body =
      path === "/api/ssh/status"
        ? statusAnswer.body
        : path === "/api/ssh/targets/box"
          ? {
              id: "box",
              address: "a",
              port: 22,
              account: "root",
              systemType: "linux",
              nodes: ["node1"],
              state: "draft",
              notes: [],
            }
          : path === "/api/ssh/targets" || path === "/api/ssh/grants" || path === "/api/hosts"
            ? []
            : {};
    const code = path === "/api/ssh/status" ? statusAnswer.status : 200;
    return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  });
  const client = createQueryClient();
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(SshPageHarness, { target, props: { client, ...props } });
  open.push(() => unmount(mounted));
  return client;
}

test("Add target opens the wizard on the form", async () => {
  showReady();
  await vi.waitFor(() => expect(button("Add target")).toBeDefined());
  expect(document.body.textContent).not.toContain("Step 1 of 6");
  button("Add target").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Step 1 of 6: Target"));
});

test("a target parameter opens the wizard on that target and Cancel calls onclose", async () => {
  const onclose = vi.fn();
  showReady({ target: "box", onclose });
  await vi.waitFor(() => expect(document.body.textContent).toContain("Step 2 of 6: Key"));
  expect(document.body.textContent).toContain("Set up box");
  button("Cancel").click();
  expect(onclose).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(document.body.textContent).not.toContain("Step 2 of 6"));
});

test("a failed status refetch leaves the wizard open", async () => {
  const client = showReady({ target: "box" });
  await vi.waitFor(() => expect(document.body.textContent).toContain("Step 2 of 6: Key"));
  statusAnswer = { status: 500, body: { error: "boom" } };
  await client.refetchQueries({ queryKey: [...SSH_KEY, "status"] });
  flushSync();
  expect(client.getQueryState([...SSH_KEY, "status"])?.status).toBe("error");
  expect(document.body.textContent).toContain("Step 2 of 6: Key");
  expect(button("Create key")).toBeDefined();
});

test("a failed status refetch leaves an open approval sheet on screen", async () => {
  let statusFails = false;
  const grant = {
    id: "g1",
    nodeId: "node1",
    instanceId: "inst1",
    targetId: "nas",
    minutes: 30,
    test: false,
    state: "pending",
    requestedAt: 1,
  };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path === "/api/ssh/status" && statusFails) return new Response("{}", { status: 500 });
    const body =
      path === "/api/ssh/status"
        ? { setUp: true, method: "passphrase", nodes: [] }
        : path === "/api/ssh/grants"
          ? [grant]
          : path === "/api/ssh/targets" || path === "/api/hosts"
            ? []
            : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createQueryClient();
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(SshPageHarness, { target, props: { client } });
  open.push(() => unmount(mounted));
  await vi.waitFor(() => expect(button("Approve")).toBeDefined());
  button("Approve").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("claimed by the session"));
  statusFails = true;
  await client.refetchQueries({ queryKey: [...SSH_KEY, "status"] });
  flushSync();
  expect(client.getQueryState([...SSH_KEY, "status"])?.status).toBe("error");
  expect(document.body.textContent).toContain("claimed by the session");
});

const squashed = () => document.body.textContent!.replace(/\s+/g, " ");
const PENDING = { setUp: true, method: "passphrase", pendingRewrap: ["nas", "web"], nodes: [] };

function showWith(status: unknown) {
  let answer = status;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") return new Response(JSON.stringify({ targets: ["nas", "web"] }), { status: 200 });
    if (path === "/api/ssh/status" && answer === null) return new Response("{}", { status: 500 });
    const body =
      path === "/api/ssh/status"
        ? answer
        : path === "/api/ssh/targets" || path === "/api/ssh/grants" || path === "/api/hosts"
          ? []
          : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createQueryClient();
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(SshPageHarness, { target, props: { client } });
  open.push(() => unmount(mounted));
  return { client, fail: () => (answer = null) };
}

test("the page shows the banner when targets are pending and the Recover button for an admin", async () => {
  showWith(PENDING);
  await vi.waitFor(() => expect(squashed()).toContain("2 targets need their keys recovered."));
  expect(button("Forgot your passphrase? Recover")).toBeDefined();
  expect(document.body.textContent).not.toContain("Recover SSH access");

  button("Recover keys").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recover SSH access"));
  expect(squashed()).toContain("2 targets wait for a re-lock.");
});

test("the page shows no banner when no target is pending, and the Recover button opens the flow", async () => {
  showWith({ ...PENDING, pendingRewrap: [] });
  await vi.waitFor(() => expect(button("Forgot your passphrase? Recover")).toBeDefined());
  expect(document.body.textContent).not.toContain("need their keys recovered");
  button("Forgot your passphrase? Recover").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recover SSH access"));
});

test("a failed status refetch leaves an open recovery flow mounted", async () => {
  const { client, fail } = showWith(PENDING);
  await vi.waitFor(() => expect(button("Recover keys")).toBeDefined());
  button("Recover keys").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recover SSH access"));
  const code = document.querySelector<HTMLInputElement>('input[type="text"]')!;
  code.value = CODE;
  code.dispatchEvent(new Event("input", { bubbles: true }));
  fail();
  await client.refetchQueries({ queryKey: [...SSH_KEY, "status"] });
  flushSync();
  expect(client.getQueryState([...SSH_KEY, "status"])?.status).toBe("error");
  expect(document.body.textContent).toContain("Recover SSH access");
  expect(document.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(CODE);
});

test("the Recover button names the passphrase when the method is passphrase", async () => {
  showWith({ ...PENDING, method: "passphrase", pendingRewrap: [] });
  await vi.waitFor(() => expect(button("Forgot your passphrase? Recover")).toBeDefined());
  expect(document.body.textContent).not.toContain("Lost your passkey");
});

test("the Recover button names the passkey when the method is prf", async () => {
  showWith({ ...PENDING, method: "prf", credentialId: "-_8B", pendingRewrap: [] });
  await vi.waitFor(() => expect(button("Lost your passkey? Recover")).toBeDefined());
});

const PRF_STATUS = { setUp: true, method: "prf", credentialId: "-_8B", pendingRewrap: [], nodes: [] };
const CHECK = "Check my passkey";

function showCheck(status: unknown, canAdmin: boolean | "omit" = true) {
  const seen: string[] = [];
  let answer = status;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    seen.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/ssh/status" && answer === null) return new Response("{}", { status: 500 });
    const body =
      path === "/api/ssh/status"
        ? answer
        : path === "/api/ssh/targets" || path === "/api/ssh/grants" || path === "/api/hosts"
          ? []
          : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createQueryClient();
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(SshPageHarness, { target, props: canAdmin === "omit" ? { client } : { client, canAdmin } });
  open.push(() => unmount(mounted));
  return { client, seen, fail: () => (answer = null) };
}

const region = () => document.querySelector('[aria-live="polite"]')?.textContent?.replace(/\s+/g, " ").trim();

test("the check button is absent for a non-admin and for the passphrase method", async () => {
  showCheck(PRF_STATUS, false);
  await vi.waitFor(() => expect(button("Lost your passkey? Recover")).toBeDefined());
  expect(button(CHECK)).toBeUndefined();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
  showCheck({ ...PRF_STATUS, method: "passphrase", credentialId: undefined });
  await vi.waitFor(() => expect(button("Forgot your passphrase? Recover")).toBeDefined());
  expect(button(CHECK)).toBeUndefined();
});

test("a tap runs one unlock with a random 43 character salt and sends nothing to the hub", async () => {
  const { client, seen } = showCheck(PRF_STATUS);
  await vi.waitFor(() => expect(button(CHECK)).toBeDefined());
  await vi.waitFor(() => expect(seen).toContain("GET /api/ssh/grants"));
  await vi.waitFor(() => expect(seen).toContain("GET /api/ssh/targets"));
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0LXZhbHVlLWRpc2NhcmRlZA");
  const before = seen.length;
  button(CHECK).click();
  await vi.waitFor(() => expect(region()).toBe("Your passkey returned a PRF secret. It works."));
  expect(prf.unlockWithPasskey).toHaveBeenCalledTimes(1);
  const [id, salt] = prf.unlockWithPasskey.mock.calls[0]!;
  expect(id).toBe("-_8B");
  expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The queries are fresh (5 s) and no focus event fires, so any request here would come from the tap.
  expect(seen.slice(before)).toEqual([]);
  expect(document.body.innerHTML).not.toContain("c2VjcmV0LXZhbHVl");
  expect(JSON.stringify({ ...localStorage })).not.toContain("c2VjcmV0");
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("c2VjcmV0");
  expect(JSON.stringify(document.cookie)).not.toContain("c2VjcmV0");
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    ),
  ).not.toContain("c2VjcmV0");
  expect(client.getMutationCache().getAll()).toEqual([]);
  button(CHECK).click();
  await vi.waitFor(() => expect(prf.unlockWithPasskey).toHaveBeenCalledTimes(2));
  expect(prf.unlockWithPasskey.mock.calls[1]![1]).not.toBe(salt);
});

test("a failed check shows the message, and the hint unless the passkey lacks PRF", async () => {
  showCheck(PRF_STATUS);
  await vi.waitFor(() => expect(button(CHECK)).toBeDefined());
  prf.unlockWithPasskey.mockRejectedValue(new UnlockError("The passkey prompt was cancelled"));
  button(CHECK).click();
  await vi.waitFor(() =>
    expect(region()).toBe(
      "The passkey prompt was cancelled If the phone showed no passkey to pick, wait a few seconds and try again.",
    ),
  );
  prf.unlockWithPasskey.mockRejectedValue(new UnlockError("This passkey does not return a PRF secret"));
  button(CHECK).click();
  await vi.waitFor(() => expect(region()).toBe("This passkey does not return a PRF secret"));
});

test("the button reads Checking... and is disabled while the check runs", async () => {
  showCheck(PRF_STATUS);
  await vi.waitFor(() => expect(button(CHECK)).toBeDefined());

  let finish: (value: string) => void = () => {};

  prf.unlockWithPasskey.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
  button(CHECK).click();
  await vi.waitFor(() => expect(button("Checking...")).toBeDefined());
  expect(button("Checking...").disabled).toBe(true);
  button("Checking...").click();
  expect(prf.unlockWithPasskey).toHaveBeenCalledTimes(1);
  finish("c2VjcmV0");
  await vi.waitFor(() => expect(button(CHECK).disabled).toBe(false));
});

test("a failed status refetch keeps the button and the result", async () => {
  const { client, fail } = showCheck(PRF_STATUS);
  await vi.waitFor(() => expect(button(CHECK)).toBeDefined());
  prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
  button(CHECK).click();
  await vi.waitFor(() => expect(region()).toContain("It works."));
  fail();
  await client.refetchQueries({ queryKey: [...SSH_KEY, "status"] });
  flushSync();
  expect(client.getQueryState([...SSH_KEY, "status"])?.status).toBe("error");
  expect(button(CHECK)).toBeDefined();
  expect(region()).toContain("It works.");
});

test("the check button is disabled while the recovery flow is open", async () => {
  showCheck(PRF_STATUS);
  await vi.waitFor(() => expect(button(CHECK)).toBeDefined());
  expect(button(CHECK).disabled).toBe(false);
  button("Lost your passkey? Recover").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recover SSH access"));
  expect(button(CHECK).disabled).toBe(true);
});

test("the check button is absent unless canAdmin is passed", async () => {
  showCheck(PRF_STATUS, "omit");
  await vi.waitFor(() => expect(button("Lost your passkey? Recover")).toBeDefined());
  expect(button(CHECK)).toBeUndefined();
});
