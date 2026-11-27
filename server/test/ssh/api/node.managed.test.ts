import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeApp, onError } from "../../../src/app";
import type { Config } from "../../../src/config/parse";
import type { Instances } from "../../../src/instances/InstanceService";
import { HttpError } from "../../../src/shared/HttpError";
import { keyFingerprint } from "../../../src/ssh/agentproto";
import { sshManagedApi } from "../../../src/ssh/api/node";
import { defaultSshdReads } from "../../../src/ssh/node/commands";
import { DROPIN_MARKER, DROPIN_PATH, SshdDropin } from "../../../src/ssh/node/SshdDropin";
import type { SshManagedOptions } from "../../../src/ssh/node/types";
import type { Script } from "../../../src/ssh/provision";
import { isAccount } from "../../../src/ssh/TargetStore";
import { FakeSshd } from "../node/fakesshd";

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
let result: { code: number; stderr: string; stdout?: string };
let checks: [string, string][];
let sshdAnswer: "passed" | "skipped" | "missing";
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
      sshdReads: (account, file) => {
        checks.push([account, file]);
        return Promise.resolve(sshdAnswer);
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
  checks = [];
  sshdAnswer = "passed";
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

  test("two authorize calls with another from= leave one line, with the real sh script in a temporary home", async () => {
    const home = join(dir, "home");

    const runReal: SshManagedOptions["runAs"] = async (_account, script) => {
      const proc = Bun.spawn(["sh", "-s"], {
        stdin: new Blob([script.script]),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: home },
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    };

    await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".ssh", "authorized_keys"), "ssh-rsa KEEP me\n", { mode: 0o600 });
    build({ runAs: runReal });
    const key = "AAAAC3NzaC1lZDI1NTE5AAAAIAAA";
    const line = (from: string) => `from="${from}",restrict ssh-ed25519 ${key} claude-rc:nas`;
    const responses = await Promise.all(
      ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"].map((from) => authorize({ line: line(from) })),
    );
    expect(responses.map((response) => response.status)).toEqual([204, 204, 204, 204]);
    const lines = (await readFile(join(home, ".ssh", "authorized_keys"), "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("ssh-rsa KEEP me");
    expect(lines[1]).toMatch(
      /^from="10\.0\.0\.[1-4]",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA claude-rc:nas$/,
    );
    expect((await stat(join(home, ".ssh", "authorized_keys"))).mode & 0o777).toBe(0o600);
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

  test("POST /authorize rejects an account that the target store refuses with 400", async () => {
    for (const account of ["a b", "", "-x", 'a"b', "a'b", "a,b", "a\\b", "a".repeat(129)]) {
      expect((await authorize({ account })).status).toBe(400);
    }

    expect(calls).toHaveLength(0);
  });

  test("POST /authorize accepts every account that the target store accepts, user@domain too", async () => {
    for (const account of ["kir@example.com", "first.last", "a".repeat(128)]) {
      expect([account, (await authorize({ account, systemType: "windows" })).status]).toEqual([account, 204]);
      expect(isAccount(account)).toBe(true);
    }
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

  test("POST /authorize takes the line of a dropbear target without from", async () => {
    const line =
      "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA claude-rc:nas";
    expect((await authorize({ systemType: "dropbear", line })).status).toBe(204);
    expect((await authorize({ line: "no-pty ssh-ed25519 AAAA x" })).status).toBe(400);
    // The Dropbear form only for a dropbear target, and only with ssh-ed25519 right after the flags.
    expect((await authorize({ systemType: "linux", line })).status).toBe(400);
    const flags = "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty";
    expect((await authorize({ systemType: "dropbear", line: `${flags} ssh-rsa AAAA claude-rc:nas` })).status).toBe(400);
    expect((await authorize({ systemType: "dropbear", line: `${flags} command="x" ssh-ed25519 AAAA` })).status).toBe(
      400,
    );
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

  test("under test the default runAs refuses to run the provision script", async () => {
    // HOME is a folder of the test: a run that the guard misses still writes nowhere else.
    const standalone = sshManagedApi({
      hostKeyFile: keyFile,
      identityFor: () => Promise.resolve({ home: dir, path: "/usr/bin:/bin" }),
    });
    standalone.onError(onError);
    const response = await standalone.request("/authorize", {
      method: "POST",
      headers,
      body: JSON.stringify({ account: "alice", systemType: "linux", line: LINE }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("inject runAs");
    expect(await Bun.file(join(dir, ".ssh", "authorized_keys")).exists()).toBe(false);
  });

  test("sshManagedApi works on its own", async () => {
    const standalone = sshManagedApi({ hostKeyFile: keyFile });
    standalone.onError(onError);
    expect((await standalone.request("/hostkey")).status).toBe(200);
  });
});

describe("POST /deauthorize on the node", () => {
  const KEY = BLOB.toString("base64");
  const deauthorize = (overrides: Record<string, unknown> = {}) =>
    call("POST", "/deauthorize", { account: "alice", systemType: "linux", key: KEY, id: "nas", ...overrides });

  test("it runs the removal script for the account and answers the result of the script", async () => {
    result = { code: 0, stderr: "", stdout: "removed\n" };
    const response = await deauthorize();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "removed" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.account).toBe("alice");
    expect(calls[0]?.script.shell).toBe("sh");
    expect(calls[0]?.script.script).toContain(`'${KEY}'`);
    expect(calls[0]?.script.script).toContain("'claude-rc:nas'");

    result = { code: 0, stderr: "", stdout: "not-found\n" };
    expect(await (await deauthorize()).json()).toEqual({ result: "not-found" });
  });

  test("it hands the account to the Windows script", async () => {
    result = { code: 0, stderr: "", stdout: "removed\n" };
    await deauthorize({ systemType: "windows", account: "bob" });
    expect(calls[0]?.script.shell).toBe("powershell");
    expect(calls[0]?.script.script).toContain("'bob'");
  });

  test("it rejects bad accounts, system types, ids and keys with 400 and runs nothing", async () => {
    const bad: Record<string, unknown>[] = [
      { account: "a b" },
      { account: "-x" },
      { systemType: "plan9" },
      { id: "" },
      { id: "Nas" },
      { id: "a'b" },
      { id: "$(touch x)" },
      { id: "a\nb" },
      { id: "it’s" },
      { key: "" },
      { key: "AAAA'; touch x; '" },
      { key: "$(touch x)" },
      { key: "`touch x`" },
      { key: `${KEY}\n${KEY}` },
      { key: "it’s" },
      { key: "AAAAAAAA" },
      { key: Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("ssh-rsa"), Buffer.alloc(40)]).toString("base64") },
      { key: "A".repeat(201) },
      { key: 5 },
      { id: 5 },
    ];

    for (const overrides of bad) {
      expect([JSON.stringify(overrides), (await deauthorize(overrides)).status]).toEqual([
        JSON.stringify(overrides),
        400,
      ]);
    }

    expect(calls).toHaveLength(0);
  });

  test("it answers 500 with the error text when the script fails or prints something else", async () => {
    result = { code: 1, stderr: "cannot write", stdout: "" };
    const failed = await deauthorize();
    expect(failed.status).toBe(500);
    expect(await failed.text()).toContain("cannot write");
    result = { code: 0, stderr: "", stdout: "huh" };
    expect((await deauthorize()).status).toBe(500);
  });

  test("it answers 400 for a Windows account without a profile", async () => {
    result = { code: 1, stderr: "no profile for account 'bob': the account has never logged on", stdout: "" };
    const response = await deauthorize({ systemType: "windows", account: "bob" });
    expect(response.status).toBe(400);
  });

  test("it answers 501 and runs nothing for a shell script when the node has no user switch", async () => {
    const standalone = sshManagedApi({ hostKeyFile: keyFile });
    standalone.onError(onError);
    const response = await standalone.request("/deauthorize", {
      method: "POST",
      headers,
      body: JSON.stringify({ account: "alice", systemType: "linux", key: KEY, id: "nas" }),
    });
    expect(response.status).toBe(501);
    expect(calls).toHaveLength(0);
  });

  test("under test the default runAs refuses to run the removal script", async () => {
    const standalone = sshManagedApi({
      hostKeyFile: keyFile,
      identityFor: () => Promise.resolve({ home: dir, path: "/usr/bin:/bin" }),
    });
    standalone.onError(onError);
    const response = await standalone.request("/deauthorize", {
      method: "POST",
      headers,
      body: JSON.stringify({ account: "alice", systemType: "linux", key: KEY, id: "nas" }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("inject runAs");
  });

  test("it needs the node auth", async () => {
    const response = await app.request("/api/ssh/deauthorize", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });
});

describe("scripts of one account on the node", () => {
  const KEY = BLOB.toString("base64");
  const remove = (account = "alice") =>
    call("POST", "/deauthorize", { account, systemType: "linux", key: KEY, id: "nas" });

  function slowRunner(events: string[], failFirst = false) {
    let count = 0;

    return (account: string, script: Script, timeoutMs?: number) => {
      const number = ++count;
      events.push(`start ${account} ${number}`);
      calls.push({ account, script });
      timeoutMs;
      return new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
        setTimeout(() => {
          events.push(`end ${account} ${number}`);
          resolve(
            failFirst && number === 1
              ? { code: 1, stderr: "boom", stdout: "" }
              : { code: 0, stderr: "", stdout: "removed\n" },
          );
        }, 30);
      });
    };
  }

  test("two calls for one account run one after the other, an install and a removal too", async () => {
    const events: string[] = [];
    build({ runAs: slowRunner(events) });
    const responses = await Promise.all([authorize(), remove(), remove()]);
    expect(responses.map((response) => response.status)).toEqual([204, 200, 200]);
    expect(events).toEqual([
      "start alice 1",
      "end alice 1",
      "start alice 2",
      "end alice 2",
      "start alice 3",
      "end alice 3",
    ]);
  });

  test("a failed script does not break the chain, and other accounts run at the same time", async () => {
    const events: string[] = [];
    build({ runAs: slowRunner(events, true) });
    const responses = await Promise.all([remove(), remove()]);
    expect(responses.map((response) => response.status)).toEqual([500, 200]);
    expect(events).toEqual(["start alice 1", "end alice 1", "start alice 2", "end alice 2"]);

    events.length = 0;
    await Promise.all([remove("alice"), remove("bob")]);
    expect(events.slice(0, 2).every((event) => event.startsWith("start"))).toBe(true);
  });

  test("the removal script has a time limit of 8 seconds, below the 10 seconds of the hub", async () => {
    const limits: (number | undefined)[] = [];
    build({
      runAs: (_account, _script, timeoutMs) => {
        limits.push(timeoutMs);
        return Promise.resolve({ code: 0, stderr: "", stdout: "removed\n" });
      },
    });
    await remove();
    expect(limits).toEqual([8000]);
  });
});

describe("key file on the node routes", () => {
  const KEY = BLOB.toString("base64");

  test("POST /authorize builds the script for the chosen key file", async () => {
    const response = await authorize({ keyFile: "authorized_keys2" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keyFile: "authorized_keys2", sshdCheck: "passed" });
    expect(calls[0]?.script.script).toContain("'authorized_keys2'");
    // Without a key file the answer stays 204, for old hubs.
    expect((await authorize()).status).toBe(204);
    expect(calls[1]?.script.script).toContain("'authorized_keys'");
  });

  test("authorize answers the key file and the sshd check", async () => {
    const passed = await authorize({ keyFile: "authorized_keys.claude-rc" });
    expect(passed.status).toBe(200);
    expect(await passed.json()).toEqual({ keyFile: "authorized_keys.claude-rc", sshdCheck: "passed" });
    expect(checks).toEqual([["alice", "authorized_keys.claude-rc"]]);

    sshdAnswer = "skipped";
    const skipped = await authorize({ keyFile: "authorized_keys.claude-rc" });
    expect(await skipped.json()).toEqual({ keyFile: "authorized_keys.claude-rc", sshdCheck: "skipped" });
    expect(calls).toHaveLength(2);
  });

  test("authorize with authorized_keys or a synology key file checks nothing and answers the key file alone", async () => {
    const plain = await authorize({ keyFile: "authorized_keys" });
    expect(await plain.json()).toEqual({ keyFile: "authorized_keys" });
    const synology = await authorize({ keyFile: "authorized_keys2", systemType: "synology" });
    expect(await synology.json()).toEqual({ keyFile: "authorized_keys2" });
    expect(checks).toEqual([]);
  });

  test("authorize answers 400 that names the install command and writes nothing when sshd does not read the file", async () => {
    sshdAnswer = "missing";
    const response = await authorize({ keyFile: "authorized_keys.claude-rc" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "sshd does not read ~/.ssh/authorized_keys.claude-rc for alice. Run on this machine: sudo claude-rc node sshd install",
    );
    expect(calls).toHaveLength(0);
  });

  test("under test the default sshd check refuses to run", async () => {
    const standalone = sshManagedApi({
      hostKeyFile: keyFile,
      runAs: (account, script) => {
        calls.push({ account, script });
        return Promise.resolve(result);
      },
      identityFor: () => Promise.resolve({ home: dir, path: "/usr/bin:/bin" }),
    });
    standalone.onError(onError);
    const response = await standalone.request("/authorize", {
      method: "POST",
      headers,
      body: JSON.stringify({ account: "alice", systemType: "linux", line: LINE, keyFile: "authorized_keys.claude-rc" }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("inject sshdReads");
    expect(calls).toHaveLength(0);
  });

  test("POST /deauthorize builds the removal script for the chosen key file", async () => {
    result = { code: 0, stderr: "", stdout: "removed\n" };
    const response = await call("POST", "/deauthorize", {
      account: "alice",
      systemType: "linux",
      key: KEY,
      id: "nas",
      keyFile: "authorized_keys.claude-rc",
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.script.script).toContain("'authorized_keys.claude-rc'");
  });

  test("both routes refuse a bad key file, and dropbear and windows with one, with 400", async () => {
    const bad = [
      { keyFile: "../x" },
      { keyFile: "authorized_keys/../x" },
      { keyFile: "known_hosts" },
      { keyFile: 5 },
      { keyFile: "authorized_keys2", systemType: "dropbear" },
      { keyFile: "authorized_keys2", systemType: "windows" },
    ];

    for (const overrides of bad) {
      expect((await authorize(overrides)).status).toBe(400);
      const removal = call("POST", "/deauthorize", {
        account: "alice",
        systemType: "linux",
        key: KEY,
        id: "nas",
        ...overrides,
      });
      expect((await removal).status).toBe(400);
    }

    expect(calls).toHaveLength(0);
  });
});

describe("defaultSshdReads", () => {
  const MANAGED_LIST = "AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.claude-rc";
  const homes: (string | undefined)[] = [];

  const identityFor = (user?: string) => {
    homes.push(user);
    return Promise.resolve({ home: `/home/${user ?? "none"}`, path: "/usr/bin:/bin" });
  };

  beforeEach(() => {
    homes.length = 0;
  });

  test("defaultSshdReads skips on a node that is not root", async () => {
    const fake = new FakeSshd();
    const reads = defaultSshdReads(identityFor, () => false, new SshdDropin(fake));
    expect(await reads("alice", "authorized_keys.claude-rc")).toBe("skipped");
    expect(fake.calls).toEqual([]);
    expect(homes).toEqual([]);
  });

  test("defaultSshdReads uses the home of the account", async () => {
    const fake = new FakeSshd();
    const dropin = new SshdDropin(fake);
    const seen: [string, string, string][] = [];
    const original = dropin.readsFor.bind(dropin);

    dropin.readsFor = (account, home, file) => {
      seen.push([account, home, file]);
      return original(account, home, file);
    };

    fake.accountLists.set("alice", ["/home/alice/.ssh/authorized_keys.claude-rc"]);
    const reads = defaultSshdReads(identityFor, () => true, dropin);

    expect(await reads("alice", "authorized_keys.claude-rc")).toBe("passed");
    expect(seen).toEqual([["alice", "/home/alice", "authorized_keys.claude-rc"]]);
    expect(fake.calls).toContain("sshdEffective alice");
  });

  test("defaultSshdReads answers missing when sshd does not read the file", async () => {
    const fake = new FakeSshd();
    const reads = defaultSshdReads(identityFor, () => true, new SshdDropin(fake));
    expect(await reads("alice", "authorized_keys.claude-rc")).toBe("missing");

    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${MANAGED_LIST}\n`);
    expect(await reads("alice", "authorized_keys.claude-rc")).toBe("passed");
  });

  test("defaultSshdReads answers match-block when only a Match block of the account leaves the file out", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${MANAGED_LIST}\n`);
    fake.accountLists.set("alice", [".ssh/authorized_keys"]);
    const reads = defaultSshdReads(identityFor, () => true, new SshdDropin(fake));
    expect(await reads("alice", "authorized_keys.claude-rc")).toBe("match-block");
    expect(fake.calls).toContain("sshdEffective alice");
    expect(fake.calls).toContain("sshdEffective");
  });

  test("defaultSshdReads as root without a user switch is a 501", async () => {
    const reads = defaultSshdReads(undefined, () => true, new SshdDropin(new FakeSshd()));
    const error = await reads("alice", "authorized_keys.claude-rc").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(501);
  });

  test("defaultSshdReads without a drop-in throws under test", async () => {
    const reads = defaultSshdReads(identityFor, () => true);
    const error = await reads("alice", "authorized_keys.claude-rc").catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("inject sshdReads");
  });

  test("an account with a control character never reaches sshd -C, through the route too", async () => {
    const fake = new FakeSshd();
    build({ sshdReads: defaultSshdReads(identityFor, () => true, new SshdDropin(fake)) });
    const account = "al\u0001ice";
    expect(isAccount(account)).toBe(true);
    const response = await authorize({ account, keyFile: "authorized_keys.claude-rc" });
    expect(response.status).toBe(400);
    expect(fake.calls.filter((call) => call.startsWith("sshdEffective"))).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
