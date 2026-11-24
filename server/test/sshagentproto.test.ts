import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentProtocolError,
  FrameReader,
  MAX_FRAME,
  failureAnswer,
  identitiesAnswer,
  keyFingerprint,
  parseRequest,
  publicKeyBlob,
  publicKeyLine,
  signAnswer,
} from "../src/sshagentproto";

const raw = Uint8Array.from(Array.from({ length: 32 }, (_item, index) => index + 1));

function frame(...payload: number[]): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
}

function string(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

describe("sshagentproto", () => {
  test("publicKeyLine has the OpenSSH form", () => {
    const blob = publicKeyBlob(raw);
    expect(blob.length).toBe(4 + 11 + 4 + 32);
    const line = publicKeyLine(raw, "claude-rc:web");
    expect(line).toBe(`ssh-ed25519 ${Buffer.from(blob).toString("base64")} claude-rc:web`);
    expect(publicKeyLine(raw, "c", 'from="10.0.0.1",restrict')).toStartWith('from="10.0.0.1",restrict ssh-ed25519 ');
  });

  test("keyFingerprint matches ssh-keygen -lf", async () => {
    if (!Bun.which("ssh-keygen")) return;
    const dir = await mkdtemp(join(tmpdir(), "sshproto-"));

    try {
      const path = join(dir, "key");
      const made = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path]);
      expect(made.exitCode).toBe(0);
      const pub = (await readFile(`${path}.pub`, "utf8")).trim();
      const blob = Buffer.from(pub.split(" ")[1] ?? "", "base64");
      const key = new Uint8Array(blob.subarray(blob.length - 32));
      expect(Buffer.from(publicKeyBlob(key)).equals(blob)).toBe(true);
      const listed = Bun.spawnSync(["ssh-keygen", "-lf", `${path}.pub`]).stdout.toString();
      expect(listed.split(" ")[1]).toBe(keyFingerprint(publicKeyBlob(key)));
      expect(keyFingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("FrameReader joins a frame split over chunks", () => {
    const reader = new FrameReader();
    const whole = frame(11, 1, 2);
    expect(reader.push(whole.subarray(0, 2))).toEqual([]);
    expect(reader.push(whole.subarray(2, 5))).toEqual([]);
    expect(reader.push(whole.subarray(5))).toEqual([Uint8Array.from([11, 1, 2])]);
  });

  test("FrameReader returns two frames from one chunk", () => {
    const reader = new FrameReader();
    const out = reader.push(concat(frame(11), frame(13, 9)));
    expect(out).toEqual([Uint8Array.from([11]), Uint8Array.from([13, 9])]);
  });

  test("FrameReader throws over MAX_FRAME", () => {
    const reader = new FrameReader();
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, MAX_FRAME + 1);
    expect(() => reader.push(head)).toThrow(AgentProtocolError);
  });

  test("parseRequest maps type 11 to identities and 13 to sign", () => {
    expect(parseRequest(Uint8Array.from([11]))).toEqual({ type: "identities" });
    const blob = publicKeyBlob(raw);
    const data = text("hello");
    const payload = concat(Uint8Array.from([13]), string(blob), string(data), Uint8Array.from([0, 0, 0, 2]));
    const request = parseRequest(payload);
    expect(request).toEqual({ type: "sign", keyBlob: blob, data, flags: 2 });
  });

  test("parseRequest returns other for type 17", () => {
    expect(parseRequest(Uint8Array.from([17, 1, 2]))).toEqual({ type: "other", code: 17 });
  });

  test("parseRequest throws on a cut sign request", () => {
    const blob = publicKeyBlob(raw);
    const cut = concat(Uint8Array.from([13]), string(blob), Uint8Array.from([0, 0, 0, 9, 1]));
    expect(() => parseRequest(cut)).toThrow(AgentProtocolError);
    expect(() => parseRequest(new Uint8Array(0))).toThrow(AgentProtocolError);
  });

  test("signAnswer carries the ssh-ed25519 name and 64 bytes", () => {
    const signature = new Uint8Array(64).fill(7);
    const out = signAnswer(signature);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(0)).toBe(out.length - 4);
    expect(out[4]).toBe(14);
    expect(view.getUint32(5)).toBe(4 + 11 + 4 + 64);
    expect(view.getUint32(9)).toBe(11);
    expect(new TextDecoder().decode(out.subarray(13, 24))).toBe("ssh-ed25519");
    expect(view.getUint32(24)).toBe(64);
    expect(out.subarray(28)).toEqual(signature);
  });

  test("identitiesAnswer and failureAnswer are whole frames", () => {
    expect(failureAnswer()).toEqual(Uint8Array.from([0, 0, 0, 1, 5]));
    const blob = publicKeyBlob(raw);
    const out = identitiesAnswer([{ blob, comment: "claude-rc:web" }]);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(0)).toBe(out.length - 4);
    expect(out[4]).toBe(12);
    expect(view.getUint32(5)).toBe(1);
    expect(view.getUint32(9)).toBe(blob.length);
    expect(identitiesAnswer([])).toEqual(Uint8Array.from([0, 0, 0, 5, 12, 0, 0, 0, 0]));
  });
});
