import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureNodeCert } from "../src/tls";
import { rejection, defined } from "./support";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-tls-"));

describe("ensureNodeCert", () => {
  test("generates a P-256 self-signed leaf cert for the names", async () => {
    const dir = tmp();
    const now = new Date("2026-01-01T00:00:00Z");
    const nodeCert = await ensureNodeCert({ dir, names: ["pi.internal", "10.0.0.9", "localhost"], now: () => now });
    expect(nodeCert.created).toBe(true);
    const x509Certificate = new X509Certificate(nodeCert.certPem);
    expect(x509Certificate.subject).toBe("CN=claude-rc-node");
    expect(x509Certificate.ca).toBe(false);
    expect(x509Certificate.subjectAltName).toContain("DNS:pi.internal");
    expect(x509Certificate.subjectAltName).toContain("IP Address:10.0.0.9");
    expect(x509Certificate.subjectAltName).toContain("DNS:localhost");
    const years =
      (new Date(x509Certificate.validTo).getTime() - new Date(x509Certificate.validFrom).getTime()) /
      (365.25 * 86400e3);
    expect(years).toBeGreaterThan(4.9);
    expect(years).toBeLessThan(5.1);
    expect(Math.abs(new Date(x509Certificate.validFrom).getTime() - now.getTime())).toBeLessThan(2 * 86400e3);
    expect(x509Certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x509Certificate.checkPrivateKey(require("node:crypto").createPrivateKey(nodeCert.keyPem))).toBe(true);
    expect(nodeCert.fingerprintSha256).toBe(x509Certificate.fingerprint256.replaceAll(":", "").toLowerCase());
  });

  test.skipIf(process.platform === "win32")("key file is mode 0600, cert 0644", async () => {
    const dir = tmp();
    await ensureNodeCert({ dir, names: ["localhost"] });
    expect(statSync(path.join(dir, "node-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "node-cert.pem")).mode & 0o777).toBe(0o644);
  });

  test("second call reuses the stored cert (same fingerprint, created false)", async () => {
    const dir = tmp();
    const nodeCert = await ensureNodeCert({ dir, names: ["localhost"] });
    const item = await ensureNodeCert({ dir, names: ["localhost"] });
    expect(item.created).toBe(false);
    expect(item.fingerprintSha256).toBe(nodeCert.fingerprintSha256);
    expect(readFileSync(path.join(dir, "node-cert.pem"), "utf8")).toBe(nodeCert.certPem);
  });

  test("a subset of names is accepted; a new name is refused mentioning node-cert.pem", async () => {
    const dir = tmp();
    await ensureNodeCert({ dir, names: ["a.internal", "10.0.0.9"] });
    expect((await ensureNodeCert({ dir, names: ["a.internal"] })).created).toBe(false);
    expect((await rejection(ensureNodeCert({ dir, names: ["a.internal", "b.internal"] }))).message).toMatch(
      /node-cert\.pem/,
    );
    expect((await rejection(ensureNodeCert({ dir, names: ["10.0.0.10"] }))).message).toMatch(/node-cert\.pem/);
  });
});

describe("pinning with fetch tls.ca", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterAll(() => {
    servers.forEach((server) => {
      server.stop(true);
    });
  });

  async function serve(names: string[]) {
    const nodeCert = await ensureNodeCert({ dir: tmp(), names });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: nodeCert.certPem, key: nodeCert.keyPem },
      fetch: () => new Response("ok"),
    });
    servers.push(server);
    return { ...nodeCert, port: defined(server.port) };
  }

  const get = (url: string, tls?: { ca?: string; serverName?: string }) => fetch(url, { tls: tls });

  test("the pinned cert is accepted", async () => {
    const server = await serve(["localhost", "127.0.0.1"]);
    const response = await get(`https://localhost:${server.port}/`, { ca: server.certPem });
    expect(await response.text()).toBe("ok");
  });
  test("a different cert pinned is rejected", async () => {
    const server = await serve(["localhost"]);
    const other = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    expect(await rejection(get(`https://localhost:${server.port}/`, { ca: other.certPem }))).toBeInstanceOf(Error);
  });
  test("no ca means the default trust store, which rejects a self-signed cert", async () => {
    const server = await serve(["localhost"]);
    expect(await rejection(get(`https://localhost:${server.port}/`))).toBeInstanceOf(Error);
  });
  test("hostname is checked against the SAN", async () => {
    const server = await serve(["other.internal"]);
    expect(await rejection(get(`https://localhost:${server.port}/`, { ca: server.certPem }))).toBeInstanceOf(Error);
  });
  test("serverName inside the SAN lets us connect by IP; outside it does not", async () => {
    const server = await serve(["pi.internal"]);
    const ok = await get(`https://127.0.0.1:${server.port}/`, { ca: server.certPem, serverName: "pi.internal" });
    expect(await ok.text()).toBe("ok");
    expect(
      await rejection(get(`https://127.0.0.1:${server.port}/`, { ca: server.certPem, serverName: "evil.internal" })),
    ).toBeInstanceOf(Error);
  });
});
