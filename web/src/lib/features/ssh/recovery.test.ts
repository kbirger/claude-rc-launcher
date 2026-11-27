import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import { createRecoveryModel, slotKey } from "./recovery.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));

const CODE = "ABCD-EFGH-IJKL-MNOP";
const PASS = "correct horse battery";
type Answer = { status?: number; body: unknown };
let calls: { method: string; url: string; body: unknown }[];
let answers: Record<string, () => Answer>;
beforeEach(() => {
  prf.registerPasskey.mockReset();
  prf.unlockWithPasskey.mockReset();
  calls = [];
  answers = {
    "POST /api/ssh/recovery/begin": () => ({ body: { targets: ["nas"] } }),
    "GET /api/ssh/status": () => ({ body: { setUp: true, nodes: [], pendingProvisionerRewrap: ["nas"] } }),
  };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = answers[`${method} ${path}`]?.() ?? { body: {} };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient();
  const onclose = vi.fn();
  const { value: model, dispose } = inRoot(() => createRecoveryModel({ client, onclose }));
  flushSync();
  return { model, onclose, dispose };
}

const passphraseStart = (model: ReturnType<typeof mount>["model"]) => {
  model.code = ` ${CODE} `;
  model.choice = "passphrase";
  model.passphrase = PASS;
  model.again = PASS;
  return model.start();
};

describe("recovery model", () => {
  test("the first step checks the code and the two passphrases before any call", async () => {
    const flow = mount();
    await flow.model.start();
    expect(flow.model.problem).toBe("Type the recovery code.");
    flow.model.code = CODE;
    flow.model.choice = "passphrase";
    await flow.model.start();
    expect(flow.model.problem).toBe("Type the new passphrase.");
    flow.model.passphrase = "short";
    await flow.model.start();
    expect(flow.model.problem).toMatch(/characters/);
    flow.model.passphrase = PASS;
    flow.model.again = "other";
    await flow.model.start();
    expect(flow.model.problem).toBe("The two passphrases do not match.");
    expect(calls).toEqual([]);
    flow.dispose();
  });

  test("the begin call lists a row for each main and provisioner key, and the re-locks complete it", async () => {
    const flow = mount();
    await passphraseStart(flow.model);
    expect(calls[0]).toMatchObject({ method: "POST", body: { code: CODE, method: "passphrase" } });
    expect(flow.model.step).toBe("relock");
    expect(flow.model.rows.map(slotKey)).toEqual(["main:nas", "provisioner:nas"]);
    expect(flow.model.complete).toBe(false);
    for (const row of flow.model.rows) await flow.model.relock(row);
    const rewraps = calls.filter((call) => call.url.endsWith("/rewrap"));
    expect(rewraps.map((call) => call.body)).toEqual([
      { code: CODE, unlock: expect.objectContaining({ method: "passphrase" }) },
      { code: CODE, unlock: expect.objectContaining({ method: "passphrase" }), key: "provisioner" },
    ]);
    expect(flow.model.isDone(flow.model.rows[0]!)).toBe(true);
    expect(flow.model.complete).toBe(true);
    flow.dispose();
  });

  test("a failed read of the provisioner list blocks complete until Try again works", async () => {
    answers["POST /api/ssh/recovery/begin"] = () => ({ body: { targets: [] } });
    answers["GET /api/ssh/status"] = () => ({ status: 500, body: { error: "down" } });
    const flow = mount();
    await passphraseStart(flow.model);
    expect(flow.model.listProblem).toMatch(/did not give the list/);
    expect(flow.model.complete).toBe(false);
    answers["GET /api/ssh/status"] = () => ({ body: { setUp: true, nodes: [] } });
    await flow.model.retryList();
    expect(flow.model.listProblem).toBe("");
    expect(flow.model.complete).toBe(true);
    flow.dispose();
  });

  test("a 403 on begin reads as a wrong code", async () => {
    answers["POST /api/ssh/recovery/begin"] = () => ({ status: 403, body: { error: "nope" } });
    const flow = mount();
    await passphraseStart(flow.model);
    expect(flow.model.problem).toBe("The recovery code does not belong to this hub.");
    expect(flow.model.step).toBe("code");
    flow.dispose();
  });

  test("an unproven passkey waits for the test, and usePassphrase drops it", async () => {
    prf.registerPasskey.mockResolvedValue({ credentialId: "c1", prf: true, proved: false });
    const flow = mount();
    flow.model.code = CODE;
    await flow.model.start();
    expect(flow.model.untested).toBe("c1");
    expect(calls).toEqual([]);
    flow.model.usePassphrase();
    expect(flow.model.choice).toBe("passphrase");
    expect(flow.model.untested).toBe("");
    flow.dispose();
  });

  test("a tested passkey is sent with its id, and the re-lock taps it with the salt of the key", async () => {
    prf.registerPasskey.mockResolvedValue({ credentialId: "c1", prf: true, proved: false });
    prf.unlockWithPasskey.mockResolvedValue("c2VjcmV0");
    answers["GET /api/ssh/targets/nas/salt"] = () => ({ body: { salt: "c2FsdA" } });
    const flow = mount();
    flow.model.code = CODE;
    await flow.model.start();
    await flow.model.testPasskey();
    expect(calls[0]).toMatchObject({ body: { code: CODE, method: "prf", credentialId: "c1" } });
    await flow.model.relock(flow.model.rows[0]!);
    expect(prf.unlockWithPasskey).toHaveBeenLastCalledWith("c1", "c2FsdA");
    flow.dispose();
  });

  test("close wipes the code and the passphrases", async () => {
    const flow = mount();
    flow.model.code = CODE;
    flow.model.passphrase = PASS;
    flow.model.again = PASS;
    flow.model.close();
    expect([flow.model.code, flow.model.passphrase, flow.model.again]).toEqual(["", "", ""]);
    expect(flow.onclose).toHaveBeenCalledTimes(1);
    flow.dispose();
  });
});
