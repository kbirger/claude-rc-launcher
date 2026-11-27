import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import { ApiError } from "../../shared/http";
import type { SshStatus, TargetDetail } from "./api";
import { createProvisionerKeyModel, provisionerLoadProblem, provisionerRefusal } from "./provisioner.svelte";

const STATUS = { setUp: true, method: "passphrase", nodes: [] } as unknown as SshStatus;
const detail = (extra: Partial<TargetDetail> = {}): TargetDetail => ({
  id: "box",
  address: "a",
  port: 22,
  account: "root",
  systemType: "linux",
  nodes: ["node1"],
  state: "ready",
  notes: [],
  keyFingerprint: "SHA256:k",
  ...extra,
});

let target: { status: number; body: unknown };
let make: { status: number; body: unknown };
let posts: unknown[];
beforeEach(() => {
  target = { status: 200, body: detail() };
  make = { status: 200, body: { fingerprint: "SHA256:prov" } };
  posts = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(make.body), { status: make.status });
    }

    return new Response(JSON.stringify(target.body), { status: target.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient();
  const { value: model, dispose } = inRoot(() =>
    createProvisionerKeyModel({ client, targetId: "box", status: () => STATUS }),
  );
  flushSync();
  return { model, dispose };
}

describe("provisioner rules", () => {
  test("a managed, a Windows or a keyless target is refused", () => {
    expect(provisionerRefusal(detail())).toBe("");
    expect(provisionerRefusal(detail({ managedHost: "node1" }))).toMatch(/managed target/);
    expect(provisionerRefusal(detail({ systemType: "windows" }))).toMatch(/Windows target/);
    expect(provisionerRefusal(detail({ keyFingerprint: undefined }))).toMatch(/no key yet/);
  });

  test("a failed load says why", () => {
    expect(provisionerLoadProblem(new ApiError(403, "no"), "box")).toMatch(/Only an admin/);
    expect(provisionerLoadProblem(new ApiError(404, "no"), "box")).toBe(
      "The hub has no target named box. Check the link, or run the command again.",
    );
    expect(provisionerLoadProblem(new Error("x"), "box")).toBe("The hub did not load the target. Open the link again.");
  });
});

describe("provisioner key model", () => {
  test("a target that can have the key is eligible, and the key is made with the passphrase", async () => {
    const card = mount();
    expect(card.model.loading).toBe(true);
    await vi.waitFor(() => expect(card.model.eligible).toBe(true));
    card.model.passphrase = "pass phrase";
    await card.model.submit();
    expect(card.model.fingerprint).toBe("SHA256:prov");
    expect(card.model.finished).toBe(true);
    expect(card.model.passphrase).toBe("");
    expect(posts).toHaveLength(1);
    card.dispose();
  });

  test("a second key reads as a key that exists", async () => {
    make = { status: 409, body: { error: "the target has a provisioner key already" } };
    const card = mount();
    await vi.waitFor(() => expect(card.model.eligible).toBe(true));
    card.model.passphrase = "pass phrase";
    await card.model.submit();
    expect(card.model.existing).toBe(true);
    expect(card.model.finished).toBe(true);
    expect(card.model.problem).toBe("");
    card.dispose();
  });

  test("another error shows its text and clears the passphrase, and an empty one sends nothing", async () => {
    make = { status: 403, body: { error: "wrong unlock" } };
    const card = mount();
    await vi.waitFor(() => expect(card.model.eligible).toBe(true));
    await card.model.submit();
    expect(card.model.problem).toBe("Type the passphrase.");
    expect(posts).toHaveLength(0);
    card.model.passphrase = "pass phrase";
    await card.model.submit();
    expect(card.model.problem).toBe("wrong unlock");
    expect(card.model.passphrase).toBe("");
    expect(card.model.finished).toBe(false);
    card.dispose();
  });

  test("a failed load is not eligible", async () => {
    target = { status: 404, body: { error: "not found" } };
    const card = mount();
    await vi.waitFor(() => expect(card.model.failed).toBe(true));
    expect(card.model.eligible).toBe(false);
    expect(card.model.loadProblem).toMatch(/no target named box/);
    card.dispose();
  });
});
