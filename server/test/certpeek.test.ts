import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { PeekError, peekCertificate } from "../src/certpeek";
import { ensureNodeCert } from "../src/tls";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const cert = await ensureNodeCert({ dir: mkdtempSync(path.join(os.tmpdir(), "rc-peek-")), names: ["localhost", "127.0.0.1"] });

function serve() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: cert.certPem, key: cert.keyPem }, fetch: () => new Response("ok") });
  stops.push(() => server.stop(true));
  return server.port!;
}

describe("peekCertificate", () => {
  test("returns the same fingerprint that ensureNodeCert reports", async () => {
    const p = await peekCertificate({ url: `https://127.0.0.1:${serve()}` });
    expect(p.fingerprint).toBe(`sha256:${cert.fingerprintSha256}`);
    expect(p.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("returns names, subject, expiry and a PEM that parses", async () => {
    const p = await peekCertificate({ url: `https://localhost:${serve()}` });
    expect(new X509Certificate(p.pem).raw.equals(new X509Certificate(cert.certPem).raw)).toBe(true);
    expect(p.names).toEqual(expect.arrayContaining(["localhost", "127.0.0.1"]));
    expect(p.subject).toContain("claude-rc-node");
    expect(Date.parse(p.notAfter)).toBeGreaterThan(Date.now());
  });

  test("a closed port gives PeekError unreachable", async () => {
    const s = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const port = (s.address() as net.AddressInfo).port;
    s.close();
    await new Promise((r) => s.once("close", r));
    await expect(peekCertificate({ url: `https://127.0.0.1:${port}`, timeoutMs: 2000 })).rejects.toMatchObject({ name: "PeekError", reason: "unreachable" });
  });

  test("a server that never answers the handshake gives PeekError timeout", async () => {
    const s = net.createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    stops.push(() => s.close());
    const port = (s.address() as net.AddressInfo).port;
    await expect(peekCertificate({ url: `https://127.0.0.1:${port}`, timeoutMs: 200 })).rejects.toMatchObject({ reason: "timeout" });
  });

  test("a plain TCP server that is not TLS gives PeekError unreachable", async () => {
    const s = net.createServer((c) => c.end("HTTP/1.1 400 Bad Request\r\n\r\n")).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    stops.push(() => s.close());
    const port = (s.address() as net.AddressInfo).port;
    await expect(peekCertificate({ url: `https://127.0.0.1:${port}`, timeoutMs: 2000 })).rejects.toBeInstanceOf(PeekError);
  });

  test("sends no application data after the handshake", async () => {
    let bytes = 0;
    const s = tls.createServer({ cert: cert.certPem, key: cert.keyPem }, (sock) => {
      sock.on("data", (d) => (bytes += d.length));
      sock.on("error", () => {});
    }).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    stops.push(() => s.close());
    const port = (s.address() as net.AddressInfo).port;
    await peekCertificate({ url: `https://127.0.0.1:${port}` });
    await Bun.sleep(100);
    expect(bytes).toBe(0);
  });
});
