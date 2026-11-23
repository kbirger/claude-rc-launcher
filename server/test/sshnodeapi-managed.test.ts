import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeApp, onError } from "../src/app";
import type { Config } from "../src/config";
import type { Instances } from "../src/instances";
import { HttpError } from "../src/instances";
import { keyFingerprint } from "../src/sshagentproto";
import { sshManagedApi } from "../src/sshnodeapi";
import type { SshManagedOptions } from "../src/sshnodeapi";
import type { Script } from "../src/sshprovision";

const cfg = { mode: "node", name: "pi", roots: ["/srv"] } as unknown as Config;
const instances = { list: () => Promise.resolve([]) } as unknown as Instances;

const auth: MiddlewareHandler = async (context, next) => {
  if (context.req.header("authorization") !== "Bearer ok") return context.json({ error: "unauthorized" }, 401);
  await next();
};

const headers = { authorization: "Bearer ok", "content-type": "application/json" };

const LINE = 'from="10.0.0.1",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA claude-rc:nas';
// A valid ed25519 key blob: the type string and 32 bytes.
const BLOB = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]);

let dir: string;
let keyFile: string;
let calls: { account: string; script: Script }[];
let result: { code: number; stderr: string };
let app: ReturnType<typeof createNodeApp>;

function build(options: Partial<SshManagedOptions> = {}): void {
  app = createNodeApp({
    cfg,
    instances,
    auth,
    sshManaged: {
      hostKeyFile: keyFile,
      runAs: (account, script) => {
        calls.push({ account, script });
        return Promise.resolve(result);
      },
      ...options,
    },
  });
  app.onError(onError);
}

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/ssh${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const authorize = (overrides: Record<string, unknown> = {}) =>
  call("POST", "/authorize", { account: "alice", systemType: "linux", line: LINE, ...overrides });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "managed-"));
  keyFile = join(dir, "host.pub");
  await writeFile(keyFile, `ssh-ed25519 ${BLOB.toString("base64")} root@pi\n`);
  calls = [];
  result = { code: 0, stderr: "" };
  build();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("managed SSH targets on the node", () => {
  test("GET /hostkey returns the line and the fingerprint of the key file", async () => {
    const response = await call("GET", "/hostkey");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      keys: [{ line: `ssh-ed25519 ${BLOB.toString("base64")}`, fingerprint: keyFingerprint(new Uint8Array(BLOB)) }],
    });
  });

  test('GET /hostkey gives 404 with the text "sshd has no ed25519 host key" when the file is missing', async () => {
    build({ hostKeyFile: join(dir, "missing.pub") });
    const response = await call("GET", "/hostkey");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("sshd has no ed25519 host key");
  });

  test("POST /authorize runs the script for the account and answers 204", async () => {
    const response = await authorize();
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.account).toBe("alice");
    expect(calls[0]?.script.shell).toBe("sh");
  });

  test("POST /authorize passes the line to the script unchanged", async () => {
    await authorize();
    expect(calls[0]?.script.script).toContain(LINE.replaceAll("'", "'\\''"));
  });

  test("POST /authorize hands the account to the Windows script", async () => {
    await authorize({ systemType: "windows", account: "bob" });
    expect(calls[0]?.script.shell).toBe("powershell");
    expect(calls[0]?.script.script).toContain("bob");
  });

  test("POST /authorize rejects an account with a slash or a space with 400", async () => {
    for (const account of ["a/b", "a b", "", "-x", "a".repeat(33), "../x"]) {
      expect((await authorize({ account })).status).toBe(400);
    }

    expect(calls).toHaveLength(0);
  });

  test("POST /authorize rejects a bad system type with 400", async () => {
    expect((await authorize({ systemType: "plan9" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("POST /authorize answers 500 with the error text of the script when it fails", async () => {
    result = { code: 1, stderr: "cannot write authorized_keys" };
    const response = await authorize();
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("cannot write authorized_keys");
  });

  test("POST /authorize rejects a line that does not start with from= or ssh-ed25519 with 400", async () => {
    for (const line of ["ssh-rsa AAAA x", 'command="x" ssh-ed25519 AAAA', "", 5]) {
      expect((await authorize({ line })).status).toBe(400);
    }

    expect(calls).toHaveLength(0);
  });

  test("POST /authorize rejects a line with a line break, a NUL or more than 2000 characters", async () => {
    for (const line of [
      `${LINE}\nssh-ed25519 AAAA evil`,
      `${LINE}\r`,
      `${LINE}\0`,
      `ssh-ed25519 ${"A".repeat(2000)}`,
    ]) {
      expect((await authorize({ line })).status).toBe(400);
    }

    expect(calls).toHaveLength(0);
  });

  test("a node with only the managed routes answers 501 on the grant routes", async () => {
    expect((await call("POST", "/grants", {})).status).toBe(501);
    expect((await call("GET", "/hostkey")).status).toBe(200);
  });

  test("POST /authorize answers 400 when the account does not exist on the node", async () => {
    build({
      runAs: undefined,
      identityFor: () => Promise.reject(new HttpError(400, "unknown user")),
    });
    const response = await authorize({ account: "nobody-here" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown user");
  });

  test("the routes need the node auth", async () => {
    const response = await app.request("/api/ssh/hostkey");
    expect(response.status).toBe(401);
  });

  test("POST /authorize answers 501 and runs nothing for a shell script when the node has no user switch", async () => {
    const standalone = sshManagedApi({ hostKeyFile: keyFile });
    standalone.onError(onError);
    const response = await standalone.request("/authorize", {
      method: "POST",
      headers,
      body: JSON.stringify({ account: "alice", systemType: "linux", line: LINE }),
    });
    expect(response.status).toBe(501);
    expect(await response.text()).toContain("the node has no user switch");
    expect(calls).toHaveLength(0);
  });

  test("POST /authorize answers 400 with the text when the Windows account has no profile", async () => {
    result = { code: 1, stderr: "no profile for account 'bob': the account has never logged on" };
    const response = await authorize({ systemType: "windows", account: "bob" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no profile for account");
  });

  test("sshManagedApi works on its own", async () => {
    const standalone = sshManagedApi({ hostKeyFile: keyFile });
    standalone.onError(onError);
    expect((await standalone.request("/hostkey")).status).toBe(200);
  });
});
