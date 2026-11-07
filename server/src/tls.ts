import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { X509Certificate, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

const VALID_YEARS = 5;
const CERT_FILE = "node-cert.pem";
const KEY_FILE = "node-key.pem";
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export type NodeCert = { certPem: string; keyPem: string; fingerprintSha256: string; created: boolean };

const fingerprint = (certPem: string) => createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");

function covers(certPem: string, names: string[]): string[] {
  const cert = new X509Certificate(certPem);
  return names.filter((n) => (isIP(n) ? cert.checkIP(n) !== undefined : cert.checkHost(n) !== undefined));
}

function toPem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Returns the node's TLS certificate, generating a self-signed one on first use. A stored certificate is
 * reused so the hub's pin stays valid; if `names` are no longer covered, startup fails instead of silently
 * changing the pin.
 */
export async function ensureNodeCert(o: { dir: string; names: string[]; now?: () => Date }): Promise<NodeCert> {
  const certPath = path.join(o.dir, CERT_FILE);
  const keyPath = path.join(o.dir, KEY_FILE);
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, "utf8");
    const keyPem = readFileSync(keyPath, "utf8");
    const missing = o.names.filter((n) => !covers(certPem, [n]).length);
    if (missing.length) {
      throw new Error(
        `the stored certificate ${certPath} does not cover tls.names entries: ${missing.join(", ")}. ` +
          `Changing the certificate changes what hubs must pin, so this is not done automatically: ` +
          `delete ${CERT_FILE} and ${KEY_FILE} in ${o.dir} to generate a new one, then copy the new ${CERT_FILE} to every hub.`,
      );
    }
    return { certPem, keyPem, fingerprintSha256: fingerprint(certPem), created: false };
  }

  const now = o.now?.() ?? new Date();
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);
  const keys = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex").replace(/^([89a-f])/, "7"),
    name: "CN=claude-rc-node",
    notBefore: now,
    notAfter,
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(o.names.map((n) => ({ type: isIP(n) ? ("ip" as const) : ("dns" as const), value: n })), false),
    ],
  });
  const certPem = cert.toString("pem").replace(/\r\n/g, "\n").replace(/\n?$/, "\n");
  const keyPem = toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey));

  mkdirSync(o.dir, { recursive: true });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(certPath, certPem, { mode: 0o644 });
  chmodSync(certPath, 0o644);
  return { certPem, keyPem, fingerprintSha256: fingerprint(certPem), created: true };
}
