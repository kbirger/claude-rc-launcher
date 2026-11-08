import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { certFingerprint, createProofVerifier, loadOrCreateHubKey, ProofError, signProof, type ProofRequest } from "../src/hubproof";
import { ensureNodeCert } from "../src/tls";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-hubproof-"));
const AUD = "sha256:" + "ab".repeat(32);
const NOW = 1_800_000_000_000;
const req: ProofRequest = { method: "POST", pathAndQuery: "/api/x?y=1", body: '{"a":1}' };
const bh = createHash("sha256").update(req.body).digest("hex");
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function counter() {
  let n = 0;
  return () => `jti-${++n}`;
}

async function setup() {
  const key = await loadOrCreateHubKey(tmp());
  const verify = createProofVerifier({ keys: [key.publicKey], selfFingerprint: AUD, now: () => NOW });
  return { key, verify };
}

const sign = (key: any, r = req, aud = AUD, now = NOW, jti = counter()) => signProof(key, r, aud, { now: () => now, jti });

describe("hub proof", () => {
  test("round trip: a signed proof verifies", async () => {
    const { key, verify } = await setup();
    await verify(await sign(key), req);
  });

  test("rejects a wrong aud", async () => {
    const { key, verify } = await setup();
    await expect(verify(await sign(key, req, "sha256:" + "cd".repeat(32)), req)).rejects.toBeInstanceOf(ProofError);
  });

  test("rejects an expired proof", async () => {
    const { key, verify } = await setup();
    await expect(verify(await sign(key, req, AUD, NOW - 40_000), req)).rejects.toBeInstanceOf(ProofError);
  });

  test("rejects a missing exp", async () => {
    const { key, verify } = await setup();
    const t = await new SignJWT({ htm: "POST", htu: req.pathAndQuery, bh, jti: "j" })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer("claude-rc-hub").setAudience(AUD).setIssuedAt(NOW / 1000).sign(key.privateKey);
    const e = await verify(t, req).catch((x) => x);
    expect(e).toBeInstanceOf(ProofError);
    expect(e.message).toMatch(/exp/i);
  });

  test("rejects exp - iat of 61 s", async () => {
    const { key, verify } = await setup();
    const iat = NOW / 1000;
    const t = await new SignJWT({ htm: req.method, htu: req.pathAndQuery, bh, jti: "long" })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer("claude-rc-hub").setAudience(AUD).setIssuedAt(iat).setExpirationTime(iat + 61).sign(key.privateKey);
    const e = await verify(t, req).catch((x) => x);
    expect(e).toBeInstanceOf(ProofError);
    expect(e.message).toMatch(/lifetime/i);
  });

  test("rejects a changed method, path or body", async () => {
    const { key, verify } = await setup();
    const t = await sign(key);
    await expect(verify(t, { ...req, method: "GET" })).rejects.toBeInstanceOf(ProofError);
    const t2 = await sign(key);
    await expect(verify(t2, { ...req, pathAndQuery: "/api/x?y=2" })).rejects.toBeInstanceOf(ProofError);
    const t3 = await sign(key);
    await expect(verify(t3, { ...req, body: '{"a":2}' })).rejects.toBeInstanceOf(ProofError);
  });

  test("rejects the same jti twice", async () => {
    const { key, verify } = await setup();
    const t = await sign(key);
    await verify(t, req);
    await expect(verify(t, req)).rejects.toBeInstanceOf(ProofError);
  });

  test("rejects an HS256 token signed with the public key bytes", async () => {
    const { key, verify } = await setup();
    const secret = new Uint8Array(Buffer.from(key.publicKey, "base64url"));
    const t = await new SignJWT({ htm: "POST", htu: req.pathAndQuery, bh, jti: "h" })
      .setProtectedHeader({ alg: "HS256", kid: key.kid })
      .setIssuer("claude-rc-hub").setAudience(AUD).setIssuedAt(NOW / 1000).setExpirationTime(NOW / 1000 + 30).sign(secret);
    const e = await verify(t, req).catch((x) => x);
    expect(e).toBeInstanceOf(ProofError);
    expect(e.message).toMatch(/not allowed/i);
  });

  test("rejects an alg none token", async () => {
    const { key, verify } = await setup();
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const t = `${enc({ alg: "none", kid: key.kid })}.${enc({ iss: "claude-rc-hub", aud: AUD, iat: NOW / 1000, exp: NOW / 1000 + 30, jti: "n", htm: "POST", htu: req.pathAndQuery, bh })}.`;
    const e = await verify(t, req).catch((x) => x);
    expect(e).toBeInstanceOf(ProofError);
    expect(e.message).toMatch(/not allowed/i);
  });

  test("rejects an unknown kid", async () => {
    const { verify } = await setup();
    const other = await loadOrCreateHubKey(tmp());
    await expect(verify(await sign(other), req)).rejects.toBeInstanceOf(ProofError);
  });

  test("accepts clock skew of 4 s and rejects 6 s", async () => {
    const { key } = await setup();
    const at = (ms: number) => createProofVerifier({ keys: [key.publicKey], selfFingerprint: AUD, now: () => ms });
    // sign at NOW; exp = NOW + 30 s. Verify 34 s later (4 s past exp) and 36 s later (6 s past exp).
    await at(NOW + 34_000)(await sign(key), req);
    await expect(at(NOW + 36_000)(await sign(key), req)).rejects.toBeInstanceOf(ProofError);
    // iat in the future
    await at(NOW - 4_000)(await sign(key), req);
    await expect(at(NOW - 6_000)(await sign(key), req)).rejects.toBeInstanceOf(ProofError);
  });
});

describe("loadOrCreateHubKey", () => {
  test("creates the file with mode 0600 and returns the same kid on the second call", async () => {
    const dir = tmp();
    const a = await loadOrCreateHubKey(dir);
    expect(statSync(path.join(dir, "hub-key.pem")).mode & 0o777).toBe(0o600);
    const b = await loadOrCreateHubKey(dir);
    expect(b.kid).toBe(a.kid);
    expect(b.publicKey).toBe(a.publicKey);
  });

  test("throws and does not overwrite when the file is corrupt", async () => {
    const dir = tmp();
    const f = path.join(dir, "hub-key.pem");
    writeFileSync(f, "not a key", { mode: 0o600 });
    await expect(loadOrCreateHubKey(dir)).rejects.toThrow();
    expect(readFileSync(f, "utf8")).toBe("not a key");
  });

  test("throws with a plain next step and does not overwrite when the file is empty", async () => {
    const dir = tmp();
    const f = path.join(dir, "hub-key.pem");
    writeFileSync(f, "", { mode: 0o600 });
    await expect(loadOrCreateHubKey(dir)).rejects.toThrow(
      `cannot parse ${f}. If the file is empty or damaged, delete it and restart the hub, then update the hub key on every node (see "Rotating the hub key" in the README).`,
    );
    expect(readFileSync(f, "utf8")).toBe("");
  });

  test("throws and does not replace the path when it cannot be read (a directory, which fails for root too)", async () => {
    const dir = tmp();
    const f = path.join(dir, "hub-key.pem");
    mkdirSync(f);
    await expect(loadOrCreateHubKey(dir)).rejects.toThrow(`cannot read hub key ${f}`);
    expect(statSync(f).isDirectory()).toBe(true);
  });

  test("kid is 16 hex characters and publicKey is 32 raw bytes", async () => {
    const k = await loadOrCreateHubKey(tmp());
    expect(k.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(k.publicKey, "base64url")).toHaveLength(32);
    expect(b64u(Buffer.from(k.publicKey, "base64url"))).toBe(k.publicKey);
  });
});

describe("certFingerprint", () => {
  test("returns sha256:<hex> matching ensureNodeCert", async () => {
    const c = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    expect(certFingerprint(c.certPem)).toBe(`sha256:${c.fingerprintSha256}`);
  });
});
