// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import SshPageHarness from "./SshPageHarness.svelte";
import { SSH_KEY } from "./queries";

const CODE = "ABCD-EFGH-IJKL-MNOP";
let statusAnswer: { status: number; body: unknown };
const open: Array<() => void> = [];

beforeEach(() => {
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
  expect(button("Lost your passkey? Recover")).toBeDefined();
  expect(document.body.textContent).not.toContain("Recover SSH access");

  button("Recover keys").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Recover SSH access"));
  expect(squashed()).toContain("2 targets wait for a re-lock.");
});

test("the page shows no banner when no target is pending, and the Recover button opens the flow", async () => {
  showWith({ ...PENDING, pendingRewrap: [] });
  await vi.waitFor(() => expect(button("Lost your passkey? Recover")).toBeDefined());
  expect(document.body.textContent).not.toContain("need their keys recovered");
  button("Lost your passkey? Recover").click();
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
