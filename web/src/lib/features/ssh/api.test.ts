import { expect, test } from "vitest";
import { ApiError } from "../../shared/http";
import { useFetchStub } from "../../../../test/fetch-stub";
import * as api from "./api";

const { calls, stub } = useFetchStub();

const unlock = { method: "passphrase", secret: "c2VjcmV0" } as const;
const last = () => calls.at(-1)!;
const sent = () => JSON.parse(String(last().init?.body));

test("each function calls its route with the right method and path", async () => {
  stub(200, {});
  const table: Array<[() => Promise<unknown>, string, string, unknown?]> = [
    [() => api.getStatus(), "GET", "/api/ssh/status"],
    [
      () => api.setup({ method: "prf", credentialId: "abc" }),
      "POST",
      "/api/ssh/setup",
      { method: "prf", credentialId: "abc" },
    ],
    [
      () => api.putNode("a/b", { enabled: true, sourceAddress: "10.0.0.1" }),
      "PUT",
      "/api/ssh/nodes/a%2Fb",
      { enabled: true, sourceAddress: "10.0.0.1" },
    ],
    [() => api.listTargets(), "GET", "/api/ssh/targets"],
    [
      () => api.createTarget({ id: "nas", account: "root", systemType: "linux", nodes: ["h"] }),
      "POST",
      "/api/ssh/targets",
      { id: "nas", account: "root", systemType: "linux", nodes: ["h"] },
    ],
    [() => api.getTarget("nas"), "GET", "/api/ssh/targets/nas"],
    [() => api.patchTarget("nas", "disabled"), "PATCH", "/api/ssh/targets/nas", { state: "disabled" }],
    [() => api.deleteTarget("nas"), "DELETE", "/api/ssh/targets/nas"],
    [() => api.getSalt("nas"), "GET", "/api/ssh/targets/nas/salt"],
    [() => api.createKey("nas", unlock), "POST", "/api/ssh/targets/nas/key", { unlock }],
    [() => api.scanHostKey("nas", "h"), "POST", "/api/ssh/targets/nas/scan", { node: "h" }],
    [
      () => api.pinHostKey("nas", "ssh-ed25519 AAAA"),
      "POST",
      "/api/ssh/targets/nas/pin",
      { hostKey: "ssh-ed25519 AAAA" },
    ],
    [() => api.pinManaged("nas"), "POST", "/api/ssh/targets/nas/pin-managed"],
    [() => api.getProvision("nas"), "GET", "/api/ssh/targets/nas/provision"],
    [() => api.authorizeManaged("nas"), "POST", "/api/ssh/targets/nas/authorize"],
    [() => api.testTarget("nas", "h", unlock), "POST", "/api/ssh/targets/nas/test", { node: "h", unlock }],
    [() => api.listGrants(), "GET", "/api/ssh/grants"],
    [() => api.approveGrant("g1", unlock), "POST", "/api/ssh/grants/g1/approve", { unlock }],
    [() => api.approveGrant("g1", unlock, 30), "POST", "/api/ssh/grants/g1/approve", { unlock, minutes: 30 }],
    [() => api.denyGrant("g1"), "POST", "/api/ssh/grants/g1/deny"],
    [() => api.revokeGrant("g1"), "POST", "/api/ssh/grants/g1/revoke"],
  ];

  for (const [call, method, url, body] of table) {
    await call();
    expect([last().init?.method, last().url]).toEqual([method, url]);
    if (body === undefined) expect(last().init?.body).toBeUndefined();
    else expect(sent()).toEqual(body);
  }

  expect(calls).toHaveLength(table.length);
});

test("api: beginRecovery and rewrapTarget call their routes with the right bodies", async () => {
  stub(200, { targets: ["nas"] });
  await api.beginRecovery({ code: "ABCD-EFGH", method: "prf", credentialId: "cred" });
  expect([last().init?.method, last().url]).toEqual(["POST", "/api/ssh/recovery/begin"]);
  expect(sent()).toEqual({ code: "ABCD-EFGH", method: "prf", credentialId: "cred" });

  await api.beginRecovery({ code: "ABCD-EFGH", method: "passphrase" });
  expect(sent()).toEqual({ code: "ABCD-EFGH", method: "passphrase" });

  await api.rewrapTarget("a/b", { code: "ABCD-EFGH", unlock });
  expect([last().init?.method, last().url]).toEqual(["POST", "/api/ssh/targets/a%2Fb/rewrap"]);
  expect(sent()).toEqual({ code: "ABCD-EFGH", unlock });
});

test("an error answer throws an ApiError with its status and text", async () => {
  stub(409, { error: "SSH access is not set up" });
  const error = await api.listTargets().catch((caught) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(409);
  expect(error.message).toBe("SSH access is not set up");
});
