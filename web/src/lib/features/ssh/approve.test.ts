import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import type { Grant, Maintenance, SshStatus } from "./api";
import { createApproveModel, listText, maintenanceHeadline } from "./approve.svelte";

const STATUS = { setUp: true, method: "passphrase", nodes: [] } as unknown as SshStatus;
const SESSION: Grant = {
  id: "g1",
  nodeId: "node1",
  instanceId: "i1",
  targetId: "box",
  minutes: 30,
  test: false,
  state: "pending",
  requestedAt: 1,
};
const SOURCES: Maintenance = {
  action: "sources",
  fromNodes: ["node1"],
  toNodes: ["node2"],
  fromSources: ["10.0.0.2"],
  toSources: ["10.0.0.2"],
};

type Answer = { status?: number; body: unknown };
let approve: () => Answer;
let grants: () => Answer;
let posts: { url: string; body: unknown }[];
beforeEach(() => {
  approve = () => ({ body: { ...SESSION, state: "active" } });
  grants = () => ({ body: [] });
  posts = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    let out: Answer = { body: [] };

    if (init?.method === "POST") {
      posts.push({ url: path, body: JSON.parse(String(init.body)) });
      out = approve();
    } else if (path === "/api/ssh/grants") out = grants();
    else if (path === "/api/ssh/targets")
      out = { body: [{ id: "box", systemType: "dropbear", account: "root", address: "a", port: 22, nodes: [] }] };

    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount(grant: Grant = SESSION) {
  const client = new QueryClient();
  const onclose = vi.fn();
  const { value: model, dispose } = inRoot(() => createApproveModel({ client, grant, status: () => STATUS, onclose }));
  flushSync();
  return { model, onclose, dispose };
}

describe("approve texts", () => {
  test("lists and headlines", () => {
    expect(listText([])).toBe("none");
    expect(listText(["a", "b"])).toBe("a, b");
    expect(maintenanceHeadline({ ...SOURCES, action: "uninstall" }, "box", false)).toBe(
      "This removes the key line on box.",
    );
    expect(maintenanceHeadline(SOURCES, "box", true)).toBe("This changes the list of the router script on box.");
    expect(maintenanceHeadline(SOURCES, "box", false)).toBe("This changes the key line on box.");
  });
});

describe("approve model", () => {
  test("a session request is approved with the minutes and closes", async () => {
    const sheet = mount();
    await vi.waitFor(() => expect(sheet.model.router).toBe(true));
    expect(sheet.model.work).toBeUndefined();
    sheet.model.minutes = 45;
    sheet.model.passphrase = "pass phrase";
    await sheet.model.submit();
    expect(posts[0]!.body).toMatchObject({ minutes: 45, unlock: { method: "passphrase" } });
    expect(sheet.model.passphrase).toBe("");
    expect(sheet.onclose).toHaveBeenCalledTimes(1);
    sheet.dispose();
  });

  test("bad minutes are refused before any call", async () => {
    const sheet = mount();

    for (const value of [null, 0, 481, 1.5]) {
      sheet.model.minutes = value;
      await sheet.model.submit();
      expect(sheet.model.problem).toBe("The minutes must be a whole number from 1 to 480.");
    }

    expect(posts).toEqual([]);
    sheet.dispose();
  });

  test("a maintenance request sends no minutes, and a failed run ends the sheet with the detail", async () => {
    approve = () => ({ body: { ...SESSION, maintenance: { ...SOURCES, result: "failed", detail: "boom" } } });
    const sheet = mount({ ...SESSION, maintenance: SOURCES });
    expect(sheet.model.sameAddresses).toBe(true);
    sheet.model.passphrase = "pass phrase";
    await sheet.model.submit();
    expect(posts[0]!.body).not.toHaveProperty("minutes");
    expect(sheet.model.problem).toBe("The change failed. boom");
    expect(sheet.model.finished).toBe(true);
    expect(sheet.onclose).not.toHaveBeenCalled();
    sheet.dispose();
  });

  test("an error of a maintenance run reads the result from the list of grants", async () => {
    approve = () => ({ status: 502, body: { error: "the node is gone" } });
    grants = () => ({ body: [{ ...SESSION, maintenance: { ...SOURCES, result: "failed", detail: "" } }] });
    const sheet = mount({ ...SESSION, maintenance: SOURCES });
    sheet.model.passphrase = "pass phrase";
    await sheet.model.submit();
    expect(sheet.model.problem).toBe("The change failed. the node is gone");
    expect(sheet.model.finished).toBe(true);
    sheet.dispose();
  });

  test("a grant that ended before the run reads as finished with a capital letter", async () => {
    approve = () => ({ status: 409, body: { error: "the grant ended before the run started" } });
    const sheet = mount();
    sheet.model.passphrase = "pass phrase";
    await sheet.model.submit();
    expect(sheet.model.problem).toBe("The grant ended before the run started");
    expect(sheet.model.finished).toBe(true);
    sheet.dispose();
  });

  test("a retire shows its notice", async () => {
    approve = () => ({
      body: { ...SESSION, retired: { removed: ["box"], failed: [], skipped: [] } },
    });
    const sheet = mount({ ...SESSION, maintenance: { ...SOURCES, action: "uninstall" } });
    sheet.model.passphrase = "pass phrase";
    await sheet.model.submit();
    expect(sheet.model.finished).toBe(true);
    expect(sheet.model.notice).not.toBe("");
    sheet.dispose();
  });
});
