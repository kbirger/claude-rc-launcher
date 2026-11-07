import { X509Certificate, createHash } from "node:crypto";
import { isIP } from "node:net";
import tls from "node:tls";

export type PeekedCert = { pem: string; fingerprint: string; names: string[]; subject: string; notAfter: string };

export class PeekError extends Error {
  constructor(public reason: "unreachable" | "timeout" | "no certificate") {
    super(reason);
    this.name = "PeekError";
  }
}

const toPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

/**
 * Reads the certificate that a node presents, so that a user can pin it after comparing the fingerprint.
 *
 * SECURITY: this is the only place where the hub connects without validating the peer. It completes the TLS
 * handshake, writes nothing, and closes the socket. The result must never be used to send a request. The hub
 * trusts the certificate only after the user typed a matching fingerprint.
 */
export function peekCertificate(o: { url: string; serverName?: string; timeoutMs?: number }): Promise<PeekedCert> {
  const u = new URL(o.url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const servername = o.serverName ?? (isIP(host) ? undefined : host);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const socket = tls.connect({
      host,
      port: Number(u.port || 443),
      ...(servername ? { servername } : {}),
      rejectUnauthorized: false, // see the comment above: handshake only, nothing is sent
    });
    const timer = setTimeout(() => finish(() => reject(new PeekError("timeout"))), o.timeoutMs ?? 5_000);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      if (!peer?.raw) return finish(() => reject(new PeekError("no certificate")));
      const raw = Buffer.from(peer.raw);
      const x = new X509Certificate(raw);
      const names = (x.subjectAltName ?? "")
        .split(/,\s*/)
        .map((e) => /^(?:DNS|IP Address):(.+)$/.exec(e)?.[1])
        .filter((e): e is string => !!e);
      finish(() =>
        resolve({
          pem: toPem(raw),
          fingerprint: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
          names,
          subject: x.subject.replace(/\n/g, ", "),
          notAfter: new Date(x.validTo).toISOString(),
        }),
      );
    });
    socket.once("error", () => finish(() => reject(new PeekError("unreachable"))));
  });
}
