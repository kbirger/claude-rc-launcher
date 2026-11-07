import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureNodeCert } from "../src/tls";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-tls-"));

describe("ensureNodeCert", () => {
  test("generates a P-256 self-signed leaf cert for the names", async () => {
    const dir = tmp();
    const now = new Date("2026-01-01T00:00:00Z");
    const r = await ensureNodeCert({ dir, names: ["pi.internal", "10.0.0.9", "localhost"], now: () => now });
    expect(r.created).toBe(true);
    const x = new X509Certificate(r.certPem);
    expect(x.subject).toBe("CN=claude-rc-node");
    expect(x.ca).toBe(false);
    expect(x.subjectAltName).toContain("DNS:pi.internal");
    expect(x.subjectAltName).toContain("IP Address:10.0.0.9");
    expect(x.subjectAltName).toContain("DNS:localhost");
    const years = (new Date(x.validTo).getTime() - new Date(x.validFrom).getTime()) / (365.25 * 86400e3);
    expect(years).toBeGreaterThan(4.9);
    expect(years).toBeLessThan(5.1);
    expect(Math.abs(new Date(x.validFrom).getTime() - now.getTime())).toBeLessThan(2 * 86400e3);
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x.checkPrivateKey(require("node:crypto").createPrivateKey(r.keyPem))).toBe(true);
    expect(r.fingerprintSha256).toBe(x.fingerprint256.replaceAll(":", "").toLowerCase());
  });

  test.skipIf(process.platform === "win32")("key file is mode 0600, cert 0644", async () => {
    const dir = tmp();
    await ensureNodeCert({ dir, names: ["localhost"] });
    expect(statSync(path.join(dir, "node-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "node-cert.pem")).mode & 0o777).toBe(0o644);
  });

  test("second call reuses the stored cert (same fingerprint, created false)", async () => {
    const dir = tmp();
    const a = await ensureNodeCert({ dir, names: ["localhost"] });
    const b = await ensureNodeCert({ dir, names: ["localhost"] });
    expect(b.created).toBe(false);
    expect(b.fingerprintSha256).toBe(a.fingerprintSha256);
    expect(readFileSync(path.join(dir, "node-cert.pem"), "utf8")).toBe(a.certPem);
  });

  test("a subset of names is accepted; a new name is refused mentioning node-cert.pem", async () => {
    const dir = tmp();
    await ensureNodeCert({ dir, names: ["a.internal", "10.0.0.9"] });
    expect((await ensureNodeCert({ dir, names: ["a.internal"] })).created).toBe(false);
    await expect(ensureNodeCert({ dir, names: ["a.internal", "b.internal"] })).rejects.toThrow(/node-cert\.pem/);
    await expect(ensureNodeCert({ dir, names: ["10.0.0.10"] })).rejects.toThrow(/node-cert\.pem/);
  });
});

describe("pinning with fetch tls.ca", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterAll(() => servers.forEach((s) => s.stop(true)));
  async function serve(names: string[]) {
    const c = await ensureNodeCert({ dir: tmp(), names });
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: c.certPem, key: c.keyPem }, fetch: () => new Response("ok") });
    servers.push(s);
    return { ...c, port: s.port! };
  }
  const get = (url: string, tls?: { ca?: string; serverName?: string }) => fetch(url, { tls: tls as any });

  test("the pinned cert is accepted", async () => {
    const s = await serve(["localhost", "127.0.0.1"]);
    const r = await get(`https://localhost:${s.port}/`, { ca: s.certPem });
    expect(await r.text()).toBe("ok");
  });
  test("a different cert pinned is rejected", async () => {
    const s = await serve(["localhost"]);
    const other = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    await expect(get(`https://localhost:${s.port}/`, { ca: other.certPem })).rejects.toThrow();
  });
  test("no ca means the default trust store, which rejects a self-signed cert", async () => {
    const s = await serve(["localhost"]);
    await expect(get(`https://localhost:${s.port}/`)).rejects.toThrow();
  });
  test("hostname is checked against the SAN", async () => {
    const s = await serve(["other.internal"]);
    await expect(get(`https://localhost:${s.port}/`, { ca: s.certPem })).rejects.toThrow();
  });
  test("serverName inside the SAN lets us connect by IP; outside it does not", async () => {
    const s = await serve(["pi.internal"]);
    const ok = await get(`https://127.0.0.1:${s.port}/`, { ca: s.certPem, serverName: "pi.internal" });
    expect(await ok.text()).toBe("ok");
    await expect(get(`https://127.0.0.1:${s.port}/`, { ca: s.certPem, serverName: "evil.internal" })).rejects.toThrow();
  });
});
