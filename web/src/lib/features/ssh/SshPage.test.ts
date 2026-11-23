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
  vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const answer = init?.method === "POST" ? { status: 200, body: { recoveryCode: CODE } } : statusAnswer;
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
          : path === "/api/ssh/targets" || path === "/api/hosts"
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
