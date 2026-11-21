import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { PeekError, peekCertificate } from "../src/certpeek";
import { ensureNodeCert } from "../src/tls";
import { rejection, defined } from "./support";

const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});
const cert = await ensureNodeCert({
  dir: mkdtempSync(path.join(os.tmpdir(), "rc-peek-")),
  names: ["localhost", "127.0.0.1"],
});

function serve() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch: () => new Response("ok"),
  });
  stops.push(() => server.stop(true));
  return defined(server.port);
}

describe("peekCertificate", () => {
  test("returns the same fingerprint that ensureNodeCert reports", async () => {
    const peekedCert = await peekCertificate({ url: `https://127.0.0.1:${serve()}` });
    expect(peekedCert.fingerprint).toBe(`sha256:${cert.fingerprintSha256}`);
    expect(peekedCert.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("returns names, subject, expiry and a PEM that parses", async () => {
    const peekedCert = await peekCertificate({ url: `https://localhost:${serve()}` });
    expect(new X509Certificate(peekedCert.pem).raw.equals(new X509Certificate(cert.certPem).raw)).toBe(true);
    expect(peekedCert.names).toEqual(expect.arrayContaining(["localhost", "127.0.0.1"]));
    expect(peekedCert.subject).toContain("claude-rc-node");
    expect(Date.parse(peekedCert.notAfter)).toBeGreaterThan(Date.now());
  });

  test("a closed port gives PeekError unreachable", async () => {
    const server = net.createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as net.AddressInfo).port;
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    expect(await rejection(peekCertificate({ url: `https://127.0.0.1:${port}`, timeoutMs: 2000 }))).toMatchObject({
      name: "PeekError",
      reason: "unreachable",
    });
  });

  test("a server that never answers the handshake gives PeekError timeout", async () => {
    const server = net.createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    stops.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    expect(await rejection(peekCertificate({ url: `https://127.0.0.1:${port}`, timeoutMs: 200 }))).toMatchObject({
      reason: "timeout",
    });
  });

  test("a plain TCP server that is not TLS gives PeekError unreachable", async () => {
    const server = net.createServer((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    stops.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    expect(await rejection(peekCertificate({ url: `https://127.0.0.1:${port}`, timeoutMs: 2000 }))).toBeInstanceOf(
      PeekError,
    );
  });

  test("sends no application data after the handshake", async () => {
    let bytes = 0;
    const server = tls
      .createServer({ cert: cert.certPem, key: cert.keyPem }, (sock) => {
        sock.on("data", (item) => (bytes += item.length));
        sock.on("error", () => {});
      })
      .listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    stops.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    await peekCertificate({ url: `https://127.0.0.1:${port}` });
    await Bun.sleep(100);
    expect(bytes).toBe(0);
  });
});
