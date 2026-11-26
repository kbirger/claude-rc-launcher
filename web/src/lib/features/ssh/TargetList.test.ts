// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Grant, Target } from "./api";
import TargetListHarness from "./TargetListHarness.svelte";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let targets: Target[];
let patchReply: unknown;
let grants: Grant[];
let replies: Record<string, { status: number; body: unknown }>;
let localSource: string;
let approved: Grant[];
const open: Array<() => void> = [];

const target = (extra: Partial<Target> = {}): Target => ({
  id: "nas",
  address: "10.0.0.5",
  port: 22,
  account: "root",
  systemType: "synology",
  nodes: ["node1"],
  state: "ready",
  keyFingerprint: "SHA256:abc",
  ...extra,
});

beforeEach(() => {
  calls = [];
  targets = [];
  patchReply = undefined;
  grants = [];
  replies = {};
  localSource = "";
  approved = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown = { ok: true };
    let status = 200;
    if (path === "/api/ssh/grants") body = grants;
    else if (replies[`${method} ${path}`]) {
      status = replies[`${method} ${path}`]!.status;
      body = replies[`${method} ${path}`]!.body;
    } else if (path === "/api/ssh/status")
      body = {
        setUp: true,
        pendingRewrap: [],
        nodes: [
          { host: "node1", enabled: true, sourceAddress: "10.0.0.1" },
          ...(localSource ? [{ host: "local", enabled: true, sourceAddress: localSource }] : []),
          { host: "node2", enabled: true, sourceAddress: "10.0.0.2" },
          { host: "node3", enabled: false, sourceAddress: "" },
        ],
      };
    else if (method === "PATCH" && path === "/api/ssh/targets/nas" && patchReply !== undefined) body = patchReply;
    if (path === "/api/hosts") body = [{ id: "node1", name: "Garage", status: "ok" }];
    else if (path === "/api/ssh/targets" && method === "GET") body = targets;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

async function show(list: Target[]) {
  targets = list;
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = mount(TargetListHarness, {
    target: container,
    props: { client: createQueryClient(), onapprove: (grant: Grant) => approved.push(grant) },
  });
  open.push(() => unmount(mounted));
  await vi.waitFor(() => expect(container.querySelectorAll("[data-target]").length).toBe(list.length));
  return container;
}

const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
const changes = () => calls.filter((call) => call.method !== "GET");

test("TargetList shows state, address, account and nodes", async () => {
  const shown = await show([target()]);
  const text = shown.textContent ?? "";
  expect(text).toContain("nas");
  expect(text).toContain("10.0.0.5:22");
  expect(text).toContain("root");
  expect(text).toContain("synology");
  expect(text).toContain("ready");
  await vi.waitFor(() => expect(shown.textContent).toContain("Garage (node1)"));
});

test("TargetList offers Disable for a ready target and Enable for a disabled one", async () => {
  const shown = await show([target(), target({ id: "pc", state: "disabled" })]);
  const [ready, disabled] = [...shown.querySelectorAll<HTMLElement>("[data-target]")];
  expect(button("Disable", ready)).toBeDefined();
  expect(button("Enable", ready)).toBeUndefined();
  expect(button("Enable", disabled)).toBeDefined();
  expect(button("Disable", disabled)).toBeUndefined();

  button("Disable", ready)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({ method: "PATCH", url: "/api/ssh/targets/nas", body: { state: "disabled" } });

  button("Enable", disabled)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(2));
  expect(changes()[1]).toMatchObject({ method: "PATCH", url: "/api/ssh/targets/pc", body: { state: "draft" } });
});

test("TargetList Retire asks for a confirmation and then calls DELETE", async () => {
  const shown = await show([target()]);
  button("Retire", shown)!.click();
  flushSync();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(changes()).toHaveLength(0);
  expect(dialog.textContent).toContain("tries to remove the key line");
  button("Cancel", dialog)!.click();
  flushSync();
  expect(changes()).toHaveLength(0);

  button("Retire", shown)!.click();
  const again = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find((item) =>
      button("Retire", item),
    );
    expect(found).toBeDefined();
    return found!;
  });
  button("Retire", again)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({ method: "DELETE", url: "/api/ssh/targets/nas" });
});

test("TargetList shows no retired entries and no text about them", async () => {
  const shown = await show([target({ account: "admin" })]);
  expect(shown.textContent).not.toContain("retired");
  expect(shown.textContent).not.toContain("claude-rc:");
  expect(shown.querySelector('[role="status"]')).toBeNull();
});

const retireWith = async (answer: Record<string, unknown>) => {
  const list = [target({ account: "admin" })];
  const shown = await show(list);
  const base = fetch;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      calls.push({ method: "DELETE", url: String(url), body: undefined });
      targets = [];
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }

    return base(url, init);
  });
  button("Retire", shown)!.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  button("Retire", dialog)!.click();
  const status = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="status"]');
    expect(found).not.toBeNull();
    return found!;
  });
  return { shown, status };
};

const answer = { id: "nas", account: "admin", address: "10.0.0.5", port: 22, systemType: "linux", managed: true };

test.each([
  ["removed", {}, "Retired nas. The key line was removed from admin@10.0.0.5."],
  ["not-found", {}, "Retired nas. The key line was not on admin@10.0.0.5."],
  [
    "failed",
    { detail: "connect refused" },
    "Retired nas. The hub could not remove the key line from admin@10.0.0.5: connect refused. You can remove the line that ends with claude-rc:nas yourself. It no longer works.",
  ],
  [
    "manual",
    { managed: false },
    "Retired nas. You can remove the line that ends with claude-rc:nas from the authorized_keys file of admin@10.0.0.5. It no longer works.",
  ],
])("TargetList shows a notice after a retire with the line %s", async (line, extra, text) => {
  const { shown, status } = await retireWith({ ...answer, line, ...extra });
  expect(status.textContent?.replace(/\s+/g, " ").trim()).toContain(text);
  await vi.waitFor(() => expect(shown.querySelectorAll("[data-target]")).toHaveLength(0));
  expect(shown.textContent).not.toContain("retired");
  // The notice can be dismissed.
  button("Dismiss", status)!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
});

test("TargetList links a draft target to the wizard with ?target=<id>", async () => {
  const shown = await show([target({ id: "box", state: "draft" })]);
  const link = [...shown.querySelectorAll<HTMLAnchorElement>("a")].find(
    (item) => item.textContent?.trim() === "Continue setup",
  );
  expect(link?.getAttribute("href")).toBe("/ssh?target=box");
});

const boxes = (within: ParentNode) => [...within.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

async function openEditor(list: Target[]) {
  const shown = await show(list);
  button("Edit nodes", shown)!.click();
  await vi.waitFor(() => expect(boxes(shown).length).toBeGreaterThan(0));
  return shown;
}

test("Edit nodes offers the nodes with access on, checks the current ones and saves the new list", async () => {
  patchReply = target({ nodes: ["node1", "node2"] });
  const shown = await openEditor([target()]);
  expect(boxes(shown).map((box) => [box.value, box.checked])).toEqual([
    ["node1", true],
    ["node2", false],
  ]);
  const save = button("Save", shown)!;
  expect(save.disabled).toBe(true);
  boxes(shown)[1]!.click();
  flushSync();
  expect(save.disabled).toBe(false);
  save.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({
    method: "PATCH",
    url: "/api/ssh/targets/nas",
    body: { nodes: ["node1", "node2"] },
  });
  await vi.waitFor(() => expect(shown.textContent).toContain("The nodes of nas are saved."));
  expect(shown.textContent).not.toContain("replace the old line");
});

test("a node with access off stays on the list so that it can be taken out", async () => {
  const shown = await openEditor([target({ nodes: ["node1", "node3"] })]);
  expect(boxes(shown).map((box) => [box.value, box.checked])).toEqual([
    ["node1", true],
    ["node2", false],
    ["node3", true],
  ]);
  expect(shown.textContent).toContain("(access is off)");
});

test("Save is off when no node is checked", async () => {
  const shown = await openEditor([target()]);
  boxes(shown)[0]!.click();
  flushSync();
  expect(button("Save", shown)!.disabled).toBe(true);
});

test("an external target shows the new key line after the save, with a Copy button", async () => {
  const line = 'from="10.0.0.1,10.0.0.2",restrict ssh-ed25519 AAAA claude-rc:nas';
  patchReply = { ...target({ nodes: ["node1", "node2"] }), installLine: line };
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const shown = await openEditor([target()]);
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain(line));
  expect(shown.textContent).toContain("replace the old line");
  button("Copy", shown)!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(line));
  button("Done", shown)!.click();
  await vi.waitFor(() => expect(button("Done", shown)).toBeUndefined());
});

test("a dropbear target says that the key line on the router stays the same", async () => {
  patchReply = target({ nodes: ["node1", "node2"], systemType: "dropbear" });
  const shown = await openEditor([target({ systemType: "dropbear" })]);
  expect(shown.textContent).toContain("The key line on the router stays the same");
  expect(shown.textContent).not.toContain("you get the new key line");
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("The nodes of nas are saved."));
  expect(shown.textContent).toContain("Dropbear does not limit a key by address");
  expect(shown.textContent).not.toContain("replace the old line");
});

test("a managed target says that the line on the machine was updated", async () => {
  patchReply = { ...target({ nodes: ["node1", "node2"], managedHost: "node2" }), lineUpdated: true };
  const shown = await openEditor([target({ managedHost: "node2" })]);
  expect(shown.textContent).toContain("The hub updates the key line on the machine");
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("The key line on the machine was updated."));
});

test("a refusal of the hub shows its text and keeps the form", async () => {
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PATCH")
      return new Response(JSON.stringify({ error: "the key line on the machine was not updated" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    const body =
      path === "/api/ssh/targets"
        ? [target()]
        : path === "/api/ssh/status"
          ? {
              setUp: true,
              pendingRewrap: [],
              nodes: [
                { host: "node1", enabled: true, sourceAddress: "a" },
                { host: "node2", enabled: true, sourceAddress: "b" },
              ],
            }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const shown = await openEditor([target()]);
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("the key line on the machine was not updated"));
  expect(button("Save", shown)).toBeDefined();
});

test("a target without a key says nothing about a key line and accepts an empty list", async () => {
  const shown = await openEditor([target({ keyFingerprint: undefined })]);
  expect(shown.textContent).toContain("This target has no key yet");
  expect(shown.textContent).not.toContain("you get the new key line");
  expect(shown.textContent).not.toContain("The hub updates the key line");
  boxes(shown)[0]!.click();
  flushSync();
  expect(button("Save", shown)!.disabled).toBe(false);
});

test("a target with a key needs one node, and the screen says so", async () => {
  const shown = await openEditor([target()]);
  expect(shown.textContent).toContain("At least one node must have access turned on.");
});

test("while the status loads, no node is offered and none is marked as off", async () => {
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) =>
    String(url) === "/api/ssh/status" ? new Promise<Response>(() => {}) : base(url, init),
  );
  const shown = await show([target()]);
  button("Edit nodes", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("Loading the nodes..."));
  expect(shown.textContent).not.toContain("(access is off)");
  expect(boxes(shown)).toEqual([]);
  expect(button("Save", shown)!.disabled).toBe(true);
});

test("the key line text does not name a file that a Windows account does not use", async () => {
  const line = "ssh-ed25519 AAAA claude-rc:nas";
  patchReply = { ...target({ nodes: ["node1", "node2"], systemType: "windows" }), installLine: line };
  const shown = await openEditor([target({ systemType: "windows" })]);
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain(line));
  expect(shown.textContent).not.toContain("authorized_keys");
});

// A target with a provisioner: its changes go through a request that the owner approves.
const prov = (extra: Partial<Target> = {}) =>
  target({
    provisionerFingerprint: "SHA256:prov",
    provisionerScript: "/home/root/.claude-rc/provisioner-nas.sh",
    provisionerSource: "10.0.0.9",
    ...extra,
  });
const grant = (extra: Partial<Grant> = {}): Grant => ({
  id: "m1",
  nodeId: "local",
  instanceId: "hub",
  targetId: "nas",
  minutes: 5,
  test: false,
  state: "pending",
  requestedAt: 10,
  maintenance: { action: "sources", fromNodes: ["node1"], toNodes: ["node1", "node2"], fromSources: [], toSources: [] },
  ...extra,
});
const reply = (key: string, status: number, body: unknown) => (replies[key] = { status, body });
const squash = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();

test("saving nodes of a target with a provisioner opens the approve sheet", async () => {
  localSource = "10.0.0.9";
  reply("PATCH /api/ssh/targets/nas", 202, { maintenance: grant() });
  const shown = await openEditor([prov()]);
  expect(shown.textContent).toContain("The change needs your approval.");
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.querySelector("[data-nodes-waiting]")).not.toBeNull());
  const waiting = squash(shown.querySelector("[data-nodes-waiting]")!);
  expect(waiting).toContain("The change is not saved yet. You must approve the request.");
  expect(waiting).toContain("the nodes stay as they are");
  expect(shown.textContent).not.toContain("The nodes of nas are saved.");
  button("Approve now", shown)!.click();
  expect(approved.map((item) => item.id)).toEqual(["m1"]);
});

test("a 409 that asks for confirm shows a yes-or-no question and sends confirm", async () => {
  reply("PATCH /api/ssh/targets/nas", 409, {
    error: "the new list allows none of the addresses that work now: send it again with confirm",
  });
  const shown = await openEditor([prov()]);
  boxes(shown)[1]!.click();
  boxes(shown)[0]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.querySelector("[data-nodes-confirm]")).not.toBeNull());
  const asked = squash(shown.querySelector("[data-nodes-confirm]")!);
  expect(asked).toContain("The new list allows none of the addresses that work now.");
  expect(asked).not.toContain("send it again with confirm");
  expect(changes()[0]!.body).toEqual({ nodes: ["node2"] });
  // No goes back to the form with the picked list.
  button("No, go back", shown)!.click();
  await vi.waitFor(() => expect(button("Save", shown)).toBeDefined());
  expect(boxes(shown).map((box) => box.checked)).toEqual([false, true]);
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.querySelector("[data-nodes-confirm]")).not.toBeNull());

  reply("PATCH /api/ssh/targets/nas", 202, { maintenance: grant() });
  button("Yes, ask for this change", shown)!.click();
  await vi.waitFor(() => expect(shown.querySelector("[data-nodes-waiting]")).not.toBeNull());
  expect(changes().at(-1)!.body).toEqual({ nodes: ["node2"], confirm: true });
});

test("retire of a target with a provisioner opens the approve sheet", async () => {
  reply("DELETE /api/ssh/targets/nas", 202, {
    maintenance: grant({ maintenance: { action: "uninstall", fromNodes: ["node1"], fromSources: [] } }),
  });
  const shown = await show([prov()]);
  button("Retire", shown)!.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(dialog.textContent).toContain("You approve the retire");
  button("Retire", dialog)!.click();
  const status = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="status"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(squash(status)).toContain("The request to retire for nas waits for your approval. Nothing has changed yet.");
  expect(changes()[0]).toMatchObject({ method: "DELETE", url: "/api/ssh/targets/nas" });
});

test("a pending request shows on the card with an Approve button and hides the other actions", async () => {
  grants = [grant()];
  const shown = await show([prov()]);
  const pending = await vi.waitFor(() => {
    const found = shown.querySelector<HTMLElement>("[data-pending]");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(squash(pending)).toContain("Waiting for your approval: change the nodes.");
  button("Approve", pending)!.click();
  expect(approved[0]!.id).toBe("m1");
  expect(button("Retire", shown)).toBeUndefined();
  expect(button("Edit nodes", shown)).toBeUndefined();
});

const stuck = (endReason: Grant["endReason"]) =>
  grant({
    state: "ended",
    endReason,
    maintenance: { action: "uninstall", fromNodes: ["node1"], fromSources: [] },
  });

test("a denied retire shows Retire without cleanup", async () => {
  grants = [stuck("denied")];
  const shown = await show([prov({ state: "disabled" })]);
  const box = await vi.waitFor(() => {
    const found = shown.querySelector<HTMLElement>("[data-stuck-retire]");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(squash(box)).toContain("The request to retire this target was denied. Nothing was removed from the machine.");
  expect(button("Retire again", box)).toBeDefined();
  reply("DELETE /api/ssh/targets/nas?cleanup=none", 200, {
    id: "nas",
    account: "root",
    address: "10.0.0.5",
    port: 22,
    systemType: "linux",
    managed: false,
    line: "manual",
    comments: ["claude-rc:nas", "claude-rc-provisioner:nas"],
    script: "/home/root/.claude-rc/provisioner-nas.sh",
  });
  button("Retire without cleanup", box)!.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(dialog.textContent).toContain("claude-rc-provisioner:nas");
  button("Retire without cleanup", dialog)!.click();
  const status = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="status"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(changes()[0]).toMatchObject({ method: "DELETE", url: "/api/ssh/targets/nas?cleanup=none" });
  expect(squash(status)).toContain("claude-rc:nas and claude-rc-provisioner:nas");
});

test("the target card shows the provisioner state and Reinstall key line", async () => {
  localSource = "10.0.0.9";
  reply("POST /api/ssh/targets/nas/reinstall", 202, {
    maintenance: grant({ maintenance: { action: "install", fromNodes: ["node1"], fromSources: [] } }),
  });
  const shown = await show([prov(), target({ id: "plain" })]);
  const [card, plain] = [...shown.querySelectorAll<HTMLElement>("[data-target]")];
  expect(card!.textContent).toContain("provisioner");
  expect(button("Reinstall key line", plain!)).toBeUndefined();
  expect(plain!.textContent).not.toContain("provisioner");
  await vi.waitFor(() => expect(card!.querySelector("[data-stale-source]")).toBeNull());
  button("Reinstall key line", card!)!.click();
  await vi.waitFor(() => expect(changes()).toHaveLength(1));
  expect(changes()[0]).toMatchObject({ method: "POST", url: "/api/ssh/targets/nas/reinstall" });
  await vi.waitFor(() =>
    expect(document.querySelector('[role="status"]')?.textContent).toContain("put the key line back"),
  );
});

test("the target card shows the stale source warning with the repair command", async () => {
  localSource = "10.0.0.77";
  const shown = await show([prov()]);
  const warning = await vi.waitFor(() => {
    const found = shown.querySelector<HTMLElement>("[data-stale-source]");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(squash(warning)).toContain("claude-rc ssh target provisioner nas --identity <file>");
});

const clickRetire = async (shown: HTMLElement) => {
  button("Retire", shown)!.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(found).not.toBeNull();
    return found!;
  });
  button("Retire", dialog)!.click();
};

const REFUSALS: Array<[number, string]> = [
  [409, "this target has no provisioner"],
  [409, "the hub has no ssh program: install the OpenSSH client on the hub machine"],
  [409, "turn on SSH access for the node local with a source address"],
  [
    409,
    "the source address of local changed since the provisioner was installed: run claude-rc ssh target provisioner nas --identity <file>",
  ],
  [409, "this target needs its key to be recovered"],
  [409, "the host key of the target is not pinned"],
  [501, "the hub cannot run maintenance on this system"],
];

test.each(REFUSALS)(
  "a retire that the hub refuses with %i (%s) shows its text and Retire without cleanup",
  async (code, text) => {
    reply("DELETE /api/ssh/targets/nas", code, { error: text });
    const shown = await show([prov()]);
    await clickRetire(shown);
    const box = await vi.waitFor(() => {
      const found = shown.querySelector<HTMLElement>("[data-retire-refused]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(squash(box)).toContain(`The hub did not start the retire: ${text}`);
    expect(button("Retire again", box)).toBeUndefined();
    button("Retire without cleanup", box)!.click();
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dialog.textContent).toContain("claude-rc:nas");
    expect(dialog.textContent).toContain("claude-rc-provisioner:nas");
  },
);

test.each([
  [409, "a maintenance request waits for this target"],
  [409, "this target is being changed"],
  [403, "your role cannot do this"],
  [500, "the hub failed"],
])("a retire that fails with %i (%s) shows the error and no Retire without cleanup", async (code, text) => {
  reply("DELETE /api/ssh/targets/nas", code, { error: text });
  const shown = await show([prov()]);
  await clickRetire(shown);
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(text));
  expect(shown.querySelector("[data-retire-refused]")).toBeNull();
  expect(button("Retire without cleanup", shown)).toBeUndefined();
});

test("a network error on the retire shows the error and no Retire without cleanup", async () => {
  const shown = await show([prov()]);
  const base = fetch;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") throw new TypeError("network down");
    return base(url, init);
  });
  await clickRetire(shown);
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("network down"));
  expect(button("Retire without cleanup", shown)).toBeUndefined();
});

test("a stale source offers Retire without cleanup, and a turned-off local says to turn it on", async () => {
  localSource = "10.0.0.77";
  const shown = await show([prov()]);
  const warning = await vi.waitFor(() => {
    const found = shown.querySelector<HTMLElement>("[data-stale-source]");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(squash(warning)).toContain("claude-rc ssh target provisioner nas --identity <file>");
  expect(button("Retire without cleanup", warning)).toBeDefined();
});

test("a local node that is off says to turn on access and gives no command", async () => {
  localSource = "10.0.0.9";
  const base = fetch;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "/api/ssh/status")
      return new Response(
        JSON.stringify({
          setUp: true,
          pendingRewrap: [],
          nodes: [{ host: "local", enabled: false, sourceAddress: "10.0.0.9" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return base(url, init);
  });
  const shown = await show([prov()]);
  const warning = await vi.waitFor(() => {
    const found = shown.querySelector<HTMLElement>("[data-stale-source]");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(squash(warning)).toContain("Turn on access for local");
  expect(squash(warning)).not.toContain("claude-rc ssh target provisioner");
});

test.each(["denied", "expired", "revoked"] as const)("a retire that ended as %s is stuck", async (reason) => {
  grants = [stuck(reason)];
  const shown = await show([prov({ state: "disabled" })]);
  await vi.waitFor(() => expect(shown.querySelector("[data-stuck-retire]")).not.toBeNull());
  expect(button("Retire without cleanup", shown)).toBeDefined();
});

test("a later grant of any kind clears the stuck retire", async () => {
  grants = [
    stuck("denied"),
    grant({ id: "g2", state: "ended", endReason: "expired", requestedAt: 99, maintenance: undefined }),
  ];
  const shown = await show([prov({ state: "disabled" })]);
  await vi.waitFor(() => expect(button("Retire", shown)).toBeDefined());
  expect(shown.querySelector("[data-stuck-retire]")).toBeNull();
});

test("a provisioner card without an ended uninstall offers no cleanup", async () => {
  grants = [grant({ state: "ended", endReason: "denied", requestedAt: 3 })];
  const shown = await show([prov({ state: "disabled" })]);
  await vi.waitFor(() => expect(button("Retire", shown)).toBeDefined());
  expect(shown.querySelector("[data-stuck-retire]")).toBeNull();
  expect(button("Retire without cleanup", shown)).toBeUndefined();
});

test("an active maintenance run hides Edit nodes, Reinstall and Retire", async () => {
  grants = [grant({ state: "active" })];
  const shown = await show([prov()]);
  await vi.waitFor(() => expect(shown.querySelector("[data-pending]")).not.toBeNull());
  for (const label of ["Edit nodes", "Reinstall key line", "Retire"]) expect(button(label, shown)).toBeUndefined();
});

test("a PATCH of a provisioner target that answers 200 shows the saved text", async () => {
  patchReply = prov({ nodes: ["node1", "node2"] });
  const shown = await openEditor([prov()]);
  boxes(shown)[1]!.click();
  flushSync();
  button("Save", shown)!.click();
  await vi.waitFor(() => expect(shown.textContent).toContain("The nodes of nas are saved."));
  expect(shown.querySelector("[data-nodes-waiting]")).toBeNull();
});
