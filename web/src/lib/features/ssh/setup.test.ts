import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import { matchesFirstGroup, createSetupModel } from "./setup.svelte";

const prf = vi.hoisted(() => ({ registerPasskey: vi.fn(), unlockWithPasskey: vi.fn() }));
vi.mock("./prf", async (importActual) => ({ ...(await importActual<typeof import("./prf")>()), ...prf }));
import { UnlockError } from "./prf";

const CODE = "ABCD-EFGH-IJKL-MNOP";
let posts: unknown[];
beforeEach(() => {
  prf.registerPasskey.mockReset();
  prf.unlockWithPasskey.mockReset();
  posts = [];
  vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ recoveryCode: CODE }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient();
  const holding: boolean[] = [];
  const { value: model, dispose } = inRoot(() =>
    createSetupModel({ client, onholding: (value) => holding.push(value) }),
  );
  flushSync();
  return { model, client, holding, dispose };
}

describe("matchesFirstGroup", () => {
  test("compares the first four characters without case, spaces or dashes", () => {
    expect(matchesFirstGroup("abcd", CODE)).toBe(true);
    expect(matchesFirstGroup(" AB-cd ", CODE)).toBe(true);
    expect(matchesFirstGroup("abce", CODE)).toBe(false);
    expect(matchesFirstGroup("  ", CODE)).toBe(false);
  });
});

describe("setup model", () => {
  test("the passphrase method shows the code, holds the page, and Finish lets it go and refetches", async () => {
    const form = mount();
    const invalidate = vi.spyOn(form.client, "invalidateQueries");
    await form.model.begin("passphrase");
    expect(posts).toEqual([{ method: "passphrase" }]);
    expect(form.model.step).toBe("code");
    expect(form.model.recoveryCode).toBe(CODE);
    expect(form.holding).toEqual([true]);
    expect(form.model.matches).toBe(false);
    form.model.typed = "abcd";
    expect(form.model.matches).toBe(true);
    await form.model.finish();
    expect(form.model.recoveryCode).toBe("");
    expect(form.model.typed).toBe("");
    expect(form.model.step).toBe("done");
    expect(form.holding).toEqual([true, false]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ssh", "status"] });
    form.dispose();
  });

  test("a passkey without PRF offers the passphrase and sends nothing", async () => {
    prf.registerPasskey.mockResolvedValue({ credentialId: "c", prf: false, proved: false });
    const form = mount();
    await form.model.begin("prf");
    expect(form.model.problem).toMatch(/does not support the PRF extension/);
    expect(form.model.offerPassphrase).toBe(true);
    expect(posts).toEqual([]);
    form.dispose();
  });

  test("a passkey with a proved secret is sent at once", async () => {
    prf.registerPasskey.mockResolvedValue({ credentialId: "c1", prf: true, proved: true });
    const form = mount();
    await form.model.begin("prf");
    expect(form.model.note).toBe("Passkey created. It returns a PRF secret.");
    expect(posts).toEqual([{ method: "prf", credentialId: "c1" }]);
    form.dispose();
  });

  test("an untested passkey waits for the test, and a failed test shows the hint", async () => {
    prf.registerPasskey.mockResolvedValue({ credentialId: "c2", prf: true, proved: false });
    const form = mount();
    await form.model.begin("prf");
    expect(form.model.untested).toBe("c2");
    expect(form.model.note).toBe("Passkey created.");
    prf.unlockWithPasskey.mockRejectedValueOnce(new UnlockError("The passkey prompt was cancelled"));
    await form.model.testPasskey();
    expect(form.model.problem).toBe("The passkey prompt was cancelled");
    expect(form.model.hint).toBe(true);
    expect(form.model.offerPassphrase).toBe(true);
    prf.unlockWithPasskey.mockResolvedValueOnce("c2VjcmV0");
    await form.model.testPasskey();
    expect(posts).toEqual([{ method: "prf", credentialId: "c2" }]);
    expect(form.model.untested).toBe("");
    expect(form.model.step).toBe("code");
    form.dispose();
  });

  test("a change of method drops the untested passkey", async () => {
    prf.registerPasskey.mockResolvedValue({ credentialId: "c2", prf: true, proved: false });
    const form = mount();
    await form.model.begin("prf");
    form.model.choice = "passphrase";
    form.model.forgetPasskey();
    expect(form.model.untested).toBe("");
    expect(form.model.note).toBe("");
    form.dispose();
  });
});
