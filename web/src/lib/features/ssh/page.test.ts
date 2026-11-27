import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot, reactive } from "../../../../test/effect-root.svelte";
import type { Grant } from "./api";
import { createSshPageModel } from "./page.svelte";
import { SSH_KEY } from "./queries";

const grant = (extra: Partial<Grant> = {}): Grant => ({
  id: "g1",
  nodeId: "node1",
  instanceId: "i1",
  targetId: "box",
  minutes: 30,
  test: false,
  state: "pending",
  requestedAt: 1,
  ...extra,
});
const maintenance = (extra: Partial<Grant> = {}) =>
  grant({
    id: "m1",
    nodeId: "local",
    instanceId: "maintenance",
    minutes: 1,
    maintenance: { action: "sources", fromNodes: ["node1"], toNodes: ["node2"], fromSources: [], toSources: [] },
    ...extra,
  });

let grants: { status: number; body: unknown };
// With `hold` set, the grants answer waits until the test calls `release`.
let hold: boolean;
let release: (() => void) | null;
let status: unknown;
beforeEach(() => {
  grants = { status: 200, body: [] };
  hold = false;
  release = null;
  status = { setUp: true, method: "passphrase", nodes: [] };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    const path = String(url);

    if (path === "/api/ssh/grants") {
      const answer = grants;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }

    return new Response(JSON.stringify(status), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount(link: { target: string | null; provisioner: boolean }) {
  const client = new QueryClient();
  const props = reactive(link);
  const onclose = vi.fn();
  const { value: model, dispose } = inRoot(() =>
    createSshPageModel({
      client,
      target: () => props.target,
      provisioner: () => props.provisioner,
      onclose,
    }),
  );
  flushSync();
  return { model, client, props, onclose, dispose };
}

const loaded = (client: QueryClient) =>
  vi.waitFor(() => expect(client.getQueryState([...SSH_KEY, "grants"])?.status).not.toBe("pending"));

const refetchGrants = async (client: QueryClient) => {
  await client.refetchQueries({ queryKey: [...SSH_KEY, "grants"] });
  flushSync();
};

describe("ssh page model", () => {
  test("no link: no sheet, and Add target opens the wizard on the form", async () => {
    const page = mount({ target: null, provisioner: false });
    await loaded(page.client);
    flushSync();
    expect(page.model.sheet).toBeNull();
    page.model.addTarget();
    expect(page.model.sheet).toEqual({ kind: "wizard" });
    expect(page.model.busy).toBe(true);
    page.dispose();
  });

  test("a target link waits for the grants, then opens the wizard on that target", async () => {
    hold = true;
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(page.model.sheet).toBeNull();
    release!();
    await vi.waitFor(() => expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" }));
    page.dispose();
  });

  test("a target link with a pending maintenance request opens the approval sheet", async () => {
    grants = { status: 200, body: [maintenance()] };
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(page.model.sheet?.kind).toBe("approve"));
    expect(page.model.sheet).toMatchObject({ grant: { id: "m1" } });
    page.dispose();
  });

  test("a session request or an active maintenance run still opens the wizard", async () => {
    grants = { status: 200, body: [grant(), maintenance({ state: "active" })] };
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" }));
    page.dispose();
  });

  test("a pending maintenance request of another target does not count", async () => {
    grants = { status: 200, body: [maintenance({ targetId: "other" })] };
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" }));
    page.dispose();
  });

  test("a failed read of the grants opens the wizard", async () => {
    grants = { status: 500, body: { error: "boom" } };
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" }));
    page.dispose();
  });

  test("provisioner=1 opens the key card at once, whatever the grants hold", async () => {
    grants = { status: 200, body: [maintenance()] };
    hold = true;
    const page = mount({ target: "box", provisioner: true });
    expect(page.model.sheet).toEqual({ kind: "provisioner", id: "box" });
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await loaded(page.client);
    flushSync();
    expect(page.model.sheet).toEqual({ kind: "provisioner", id: "box" });
    page.dispose();
  });

  test("close calls onclose, and a refetch of the grants does not open the sheet again", async () => {
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" }));
    page.model.closeSheet();
    expect(page.model.sheet).toBeNull();
    expect(page.onclose).toHaveBeenCalledTimes(1);
    grants = { status: 200, body: [maintenance()] };
    await refetchGrants(page.client);
    expect(page.model.sheet).toBeNull();
    page.dispose();
  });

  test("a refetch of the grants does not swap the open wizard", async () => {
    const page = mount({ target: null, provisioner: false });
    await loaded(page.client);
    page.model.addTarget();
    grants = { status: 200, body: [maintenance()] };
    await refetchGrants(page.client);
    expect(page.model.sheet).toEqual({ kind: "wizard" });
    page.dispose();
  });

  test("a new link opens its sheet again after a close", async () => {
    const page = mount({ target: "box", provisioner: false });
    await vi.waitFor(() => expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" }));
    page.model.closeSheet();
    page.props.target = null;
    flushSync();
    page.props.target = "box";
    flushSync();
    expect(page.model.sheet).toEqual({ kind: "wizard", id: "box" });
    page.props.provisioner = true;
    flushSync();
    expect(page.model.sheet).toEqual({ kind: "provisioner", id: "box" });
    page.dispose();
  });

  test("approve opens the sheet for that grant, and the recovery flow opens apart", async () => {
    const page = mount({ target: null, provisioner: false });
    expect(page.model.busy).toBe(false);
    page.model.recover();
    expect(page.model.recovering).toBe(true);
    expect(page.model.busy).toBe(true);
    page.model.closeRecovery();
    expect(page.model.busy).toBe(false);
    page.model.approve(grant());
    expect(page.model.sheet).toMatchObject({ kind: "approve", grant: { id: "g1" } });
    page.dispose();
  });

  test("a target with two keys to re-lock counts once", async () => {
    status = {
      setUp: true,
      method: "passphrase",
      nodes: [{ host: "n" }],
      pendingRewrap: ["a", "b"],
      pendingProvisionerRewrap: ["a"],
    };
    const page = mount({ target: null, provisioner: false });
    await vi.waitFor(() => expect(page.model.pending).toEqual(["a", "b"]));
    expect(page.model.nodeCount).toBe(1);
    page.dispose();
  });
});
