import { SignJWT } from "jose";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { certFingerprint, createProofVerifier, loadOrCreateHubKey, ProofError, signProof } from "../src/hubproof";
import type { ProofRequest } from "../src/hubproof";
import { actStore } from "../src/roles";
import { ensureNodeCert } from "../src/tls";
import { rejection } from "./support";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-hubproof-"));
const AUD = "sha256:" + "ab".repeat(32);
const NOW = 1_800_000_000_000;
const req: ProofRequest = { method: "POST", pathAndQuery: "/api/x?y=1", body: '{"a":1}' };
const bh = createHash("sha256").update(req.body).digest("hex");
const b64u = (uint8Array: Uint8Array) => Buffer.from(uint8Array).toString("base64url");

function counter() {
  let count = 0;
  return () => `jti-${++count}`;
}

async function setup() {
  const key = await loadOrCreateHubKey(tmp());
  const verify = createProofVerifier({ keys: [key.publicKey], selfFingerprint: AUD, now: () => NOW });
  return { key, verify };
}

const sign = (key: any, proofRequest = req, aud = AUD, now = NOW, jti = counter()) =>
  signProof(key, proofRequest, aud, { now: () => now, jti });

describe("hub proof", () => {
  test("round trip: a signed proof verifies", async () => {
    const { key, verify } = await setup();
    await verify(await sign(key), req);
  });

  test("rejects a wrong aud", async () => {
    const { key, verify } = await setup();
    expect(await rejection(verify(await sign(key, req, "sha256:" + "cd".repeat(32)), req))).toBeInstanceOf(ProofError);
  });

  test("rejects an expired proof", async () => {
    const { key, verify } = await setup();
    expect(await rejection(verify(await sign(key, req, AUD, NOW - 40_000), req))).toBeInstanceOf(ProofError);
  });

  test("rejects a missing exp", async () => {
    const { key, verify } = await setup();
    const item = await new SignJWT({ htm: "POST", htu: req.pathAndQuery, bh, jti: "j" })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer("claude-rc-hub")
      .setAudience(AUD)
      .setIssuedAt(NOW / 1000)
      .sign(key.privateKey);
    const entry = await verify(item, req).catch((error) => error);
    expect(entry).toBeInstanceOf(ProofError);
    expect(entry.message).toMatch(/exp/i);
  });

  test("rejects exp - iat of 61 s", async () => {
    const { key, verify } = await setup();
    const iat = NOW / 1000;
    const item = await new SignJWT({ htm: req.method, htu: req.pathAndQuery, bh, jti: "long" })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer("claude-rc-hub")
      .setAudience(AUD)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 61)
      .sign(key.privateKey);
    const entry = await verify(item, req).catch((error) => error);
    expect(entry).toBeInstanceOf(ProofError);
    expect(entry.message).toMatch(/lifetime/i);
  });

  test("rejects a changed method, path or body", async () => {
    const { key, verify } = await setup();
    const item = await sign(key);
    expect(await rejection(verify(item, { ...req, method: "GET" }))).toBeInstanceOf(ProofError);
    const t2 = await sign(key);
    expect(await rejection(verify(t2, { ...req, pathAndQuery: "/api/x?y=2" }))).toBeInstanceOf(ProofError);
    const t3 = await sign(key);
    expect(await rejection(verify(t3, { ...req, body: '{"a":2}' }))).toBeInstanceOf(ProofError);
  });

  test("rejects the same jti twice", async () => {
    const { key, verify } = await setup();
    const item = await sign(key);
    await verify(item, req);
    expect(await rejection(verify(item, req))).toBeInstanceOf(ProofError);
  });

  test("rejects an HS256 token signed with the public key bytes", async () => {
    const { key, verify } = await setup();
    const secret = new Uint8Array(Buffer.from(key.publicKey, "base64url"));
    const item = await new SignJWT({ htm: "POST", htu: req.pathAndQuery, bh, jti: "h" })
      .setProtectedHeader({ alg: "HS256", kid: key.kid })
      .setIssuer("claude-rc-hub")
      .setAudience(AUD)
      .setIssuedAt(NOW / 1000)
      .setExpirationTime(NOW / 1000 + 30)
      .sign(secret);
    const entry = await verify(item, req).catch((error) => error);
    expect(entry).toBeInstanceOf(ProofError);
    expect(entry.message).toMatch(/not allowed/i);
  });

  test("rejects an alg none token", async () => {
    const { key, verify } = await setup();
    const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const item = `${enc({ alg: "none", kid: key.kid })}.${enc({ iss: "claude-rc-hub", aud: AUD, iat: NOW / 1000, exp: NOW / 1000 + 30, jti: "n", htm: "POST", htu: req.pathAndQuery, bh })}.`;
    const entry = await verify(item, req).catch((error) => error);
    expect(entry).toBeInstanceOf(ProofError);
    expect(entry.message).toMatch(/not allowed/i);
  });

  test("rejects an unknown kid", async () => {
    const { verify } = await setup();
    const other = await loadOrCreateHubKey(tmp());
    expect(await rejection(verify(await sign(other), req))).toBeInstanceOf(ProofError);
  });

  test("accepts clock skew of 4 s and rejects 6 s", async () => {
    const { key } = await setup();
    const at = (ms: number) => createProofVerifier({ keys: [key.publicKey], selfFingerprint: AUD, now: () => ms });
    // sign at NOW; exp = NOW + 30 s. Verify 34 s later (4 s past exp) and 36 s later (6 s past exp).
    await at(NOW + 34_000)(await sign(key), req);
    expect(await rejection(at(NOW + 36_000)(await sign(key), req))).toBeInstanceOf(ProofError);
    // iat in the future
    await at(NOW - 4_000)(await sign(key), req);
    expect(await rejection(at(NOW - 6_000)(await sign(key), req))).toBeInstanceOf(ProofError);
  });
});

describe("loadOrCreateHubKey", () => {
  test("creates the file with mode 0600 and returns the same kid on the second call", async () => {
    const dir = tmp();
    const hubKey = await loadOrCreateHubKey(dir);
    expect(statSync(path.join(dir, "hub-key.pem")).mode & 0o777).toBe(0o600);
    const orCreateHubKey = await loadOrCreateHubKey(dir);
    expect(orCreateHubKey.kid).toBe(hubKey.kid);
    expect(orCreateHubKey.publicKey).toBe(hubKey.publicKey);
  });

  test("throws and does not overwrite when the file is corrupt", async () => {
    const dir = tmp();
    const file = path.join(dir, "hub-key.pem");
    writeFileSync(file, "not a key", { mode: 0o600 });
    expect(await rejection(loadOrCreateHubKey(dir))).toBeInstanceOf(Error);
    expect(readFileSync(file, "utf8")).toBe("not a key");
  });

  test("throws with a plain next step and does not overwrite when the file is empty", async () => {
    const dir = tmp();
    const file = path.join(dir, "hub-key.pem");
    writeFileSync(file, "", { mode: 0o600 });
    expect((await rejection(loadOrCreateHubKey(dir))).message).toContain(
      `cannot parse ${file}. If the file is empty or damaged, delete it and restart the hub, then update the hub key on every node (see "Rotating the hub key" in the README).`,
    );
    expect(readFileSync(file, "utf8")).toBe("");
  });

  test("throws and does not replace the path when it cannot be read (a directory, which fails for root too)", async () => {
    const dir = tmp();
    const file = path.join(dir, "hub-key.pem");
    mkdirSync(file);
    expect((await rejection(loadOrCreateHubKey(dir))).message).toContain(`cannot read hub key ${file}`);
    expect(statSync(file).isDirectory()).toBe(true);
  });

  test("kid is 16 hex characters and publicKey is 32 raw bytes", async () => {
    const hubKey = await loadOrCreateHubKey(tmp());
    expect(hubKey.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(hubKey.publicKey, "base64url")).toHaveLength(32);
    expect(b64u(Buffer.from(hubKey.publicKey, "base64url"))).toBe(hubKey.publicKey);
  });
});

describe("certFingerprint", () => {
  test("returns sha256:<hex> matching ensureNodeCert", async () => {
    const nodeCert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    expect(certFingerprint(nodeCert.certPem)).toBe(`sha256:${nodeCert.fingerprintSha256}`);
  });
});

describe("acting user in the proof", () => {
  test("a proof signed inside actStore carries the user and the role", async () => {
    const { key, verify } = await setup();
    const jwt = await actStore.run({ sub: "kir", role: "write" }, () => sign(key));
    expect(await verify(jwt, req)).toEqual({ actSub: "kir", actRole: "write" });
  });
  test("a proof signed outside any request is for the system", async () => {
    const { key, verify } = await setup();
    expect(await verify(await sign(key), req)).toEqual({ actSub: "system", actRole: "system" });
  });
  test("a long name is cut to 128 characters", async () => {
    const { key, verify } = await setup();
    const jwt = await actStore.run({ sub: "x".repeat(300), role: "read" }, () => sign(key));
    expect(((await verify(jwt, req)) as { actSub: string }).actSub).toHaveLength(128);
  });
  test("a proof from an older hub has no acting user", async () => {
    const { key, verify } = await setup();
    const jwt = await new SignJWT({ htm: req.method, htu: req.pathAndQuery, bh, jti: "old-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer("claude-rc-hub")
      .setAudience(AUD)
      .setIssuedAt(NOW / 1000)
      .setExpirationTime(NOW / 1000 + 30)
      .sign(key.privateKey);
    expect(await verify(jwt, req)).toEqual({});
  });
});
