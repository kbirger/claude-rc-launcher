import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseCli } from "../src/args";
import type { Flags } from "../src/args";
import { ExitError } from "../src/creds";
import { HubError } from "../src/hub";
import type { HubClient } from "../src/hub";
import { sshTargetAdd, SSH_TARGET_USAGE } from "../src/sshtarget";
import { rejection } from "./support";

const HUB = "https://hub.example";
const FP = "SHA256:abcDEF123";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest";
const USAGE_START = "usage: claude-rc ssh target add <id>";
const IDENTITY = "/home/owner/.ssh/secret-identity-file";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const exitCode = (error: Error): number | undefined => (error instanceof ExitError ? error.code : undefined);

/** The body of a request as an object. */
const bodyOf = (call: Call | undefined): Record<string, unknown> => (call?.body ?? {}) as Record<string, unknown>;

type Handler = () => unknown;

interface Rig {
  calls: Call[];
  out: string[];
  prompts: string[];
  secrets: string[];
  ssh: { argv: string[]; stdin: string; knownHosts: string; mode: number }[];
  sleeps: number[];
  hub: HubClient;
  run: (flags: Flags, over?: Partial<Parameters<typeof sshTargetAdd>[0]>) => Promise<void>;
  paths: () => string[];
}

const tempFiles: string[] = [];
afterEach(() => {
  tempFiles.length = 0;
});

function rig(
  routes: Record<string, Handler>,
  options: { method?: "prf" | "passphrase"; answers?: string[]; sshCode?: number; sshStderr?: string } = {},
): Rig {
  const calls: Call[] = [];
  const out: string[] = [];
  const prompts: string[] = [];
  const secrets: string[] = [];
  const ssh: Rig["ssh"] = [];
  const sleeps: number[] = [];
  const answers = [...(options.answers ?? [])];
  const base: Partial<Record<string, Handler>> = {
    "GET /cli/api/ssh/status": () => ({ setUp: true, method: options.method ?? "passphrase", nodes: [] }),
    "POST /cli/api/ssh/targets": () => ({ id: "nas", state: "draft" }),
    "POST /cli/api/ssh/targets/nas/key": () => ({ publicLine: "x", fingerprint: FP, installLine: "y" }),
    "POST /cli/api/ssh/targets/nas/scan": () => ({ keys: [{ line: HOST_KEY, fingerprint: FP }] }),
    "POST /cli/api/ssh/targets/nas/pin": () => ({}),
    "POST /cli/api/ssh/targets/nas/pin-managed": () => ({ keys: [{ line: HOST_KEY, fingerprint: FP }] }),
    "POST /cli/api/ssh/targets/nas/authorize": () => ({ ok: true }),
    "GET /cli/api/ssh/targets/nas": () => ({ id: "nas", state: "draft", hostKey: HOST_KEY, keyFingerprint: FP }),
    "GET /cli/api/ssh/targets/nas/provision": () => ({ shell: "sh", script: "echo install\n" }),
    "POST /cli/api/ssh/targets/nas/test": () => ({ ok: true }),
    ...routes,
  };
  const hub = {
    request: (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const handler = base[`${method} ${path}`];
      if (!handler) return Promise.reject(new HubError("no route", 404, undefined));
      return Promise.resolve(handler());
    },
  } as unknown as HubClient;

  const run: Rig["run"] = (flags, over) =>
    sshTargetAdd({
      id: "nas",
      flags,
      hub,
      hubUrl: HUB,
      readLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answers.shift() ?? "");
      },
      readSecret: (prompt) => {
        prompts.push(prompt);
        secrets.push(prompt);
        return Promise.resolve(secrets.length === 1 ? "correct horse" : "second horse");
      },
      runLocal: (argv, stdin) => {
        const option = argv.find((item) => item.startsWith("UserKnownHostsFile="));
        const file = option?.slice("UserKnownHostsFile=".length) ?? "";
        ssh.push({
          argv,
          stdin,
          knownHosts: existsSync(file) ? readFileSync(file, "utf8") : "",
          mode: existsSync(file) ? statSync(file).mode & 0o777 : 0,
        });
        tempFiles.push(file);
        return Promise.resolve({ code: options.sshCode ?? 0, stderr: options.sshStderr ?? "" });
      },
      out: (line) => out.push(line),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...over,
    });

  return {
    calls,
    out,
    prompts,
    secrets,
    ssh,
    sleeps,
    hub,
    run,
    paths: () => calls.map((call) => `${call.method} ${call.path}`),
  };
}

const external: Flags = {
  type: "linux",
  address: "nas.lan",
  account: "backup",
  node: "pi,vm",
  identity: IDENTITY,
  fingerprint: FP,
};
const managed: Flags = { type: "linux", account: "backup", node: "pi", managed: "nas-host" };

describe("sshTargetAdd usage", () => {
  test("--managed together with --identity exits 1 with the usage text", async () => {
    const rg = rig({});
    const error = await rejection(rg.run({ ...managed, identity: IDENTITY }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toStartWith(USAGE_START);
    expect(rg.calls).toEqual([]);
  });

  test("an external add without --type, --address, --account, --node or --identity exits 1 with the usage text", async () => {
    for (const missing of ["type", "address", "account", "node", "identity"] as const) {
      const { [missing]: _left, ...flags } = external;
      const rg = rig({});
      const error = await rejection(rg.run(flags));
      expect(exitCode(error)).toBe(1);
      expect(error.message).toStartWith(USAGE_START);
      expect(rg.calls).toEqual([]);
    }
  });

  test("an unknown --type exits 1 and names linux, windows, synology and dropbear", async () => {
    const rg = rig({});
    const error = await rejection(rg.run({ ...external, type: "bsd" }));
    expect(exitCode(error)).toBe(1);
    for (const name of ["linux", "windows", "synology", "dropbear"]) expect(error.message).toContain(name);
    expect(rg.calls).toEqual([]);
  });

  test("a value that starts with a dash is refused before any call", async () => {
    for (const flags of [
      { ...external, address: "-oProxyCommand=x" },
      { ...external, account: "-x" },
    ]) {
      const rg = rig({});
      const error = await rejection(rg.run(flags));
      expect(exitCode(error)).toBe(1);
      expect(rg.calls).toEqual([]);
    }
  });
});

describe("sshTargetAdd external", () => {
  test("an identity that starts with a dash goes to ssh as an absolute path", async () => {
    const rg = rig({});
    await rg.run({ ...external, identity: "-x" });
    const argv = rg.ssh[0]?.argv ?? [];
    expect(argv).not.toContain("-x");
    expect(argv[argv.indexOf("-i") + 1]).toBe(path.resolve("-x"));
    expect(path.isAbsolute(argv[argv.indexOf("-i") + 1] ?? "")).toBe(true);
  });

  test("the ssh error text hides the absolute identity path only", async () => {
    const rg = rig({}, { sshCode: 255, sshStderr: `no such file ${path.resolve("-x")} and -x stays` });
    const error = await rejection(rg.run({ ...external, identity: "-x" }));
    expect(error.message).not.toContain(path.resolve("-x"));
    expect(error.message).toContain("<identity>");
  });

  test("an external add runs ssh with the identity and the provision script on stdin", async () => {
    const rg = rig({});
    await rg.run({ ...external, port: "2222" });
    expect(rg.ssh).toHaveLength(1);
    const call = rg.ssh[0];
    expect(call.stdin).toBe("echo install\n");
    const argv = call.argv;
    expect(argv[0]).toBe("ssh");
    expect(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2)).toEqual(["-i", IDENTITY]);
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).not.toContain("BatchMode=yes");
    expect(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
    expect(argv.slice(-3)).toEqual(["--", "backup@nas.lan", "sh -s"]);
    expect(rg.out).toEqual([
      "target nas created",
      `key created (${FP})`,
      "host key pinned",
      "key installed",
      "test passed: nas is ready",
    ]);
    expect(rg.calls[1]?.body).toEqual({
      id: "nas",
      systemType: "linux",
      account: "backup",
      nodes: ["pi", "vm"],
      address: "nas.lan",
      port: 2222,
    });
  });

  test("a Windows target runs the PowerShell command", async () => {
    const rg = rig({ "GET /cli/api/ssh/targets/nas/provision": () => ({ shell: "powershell", script: "x" }) });
    await rg.run({ ...external, type: "windows" });
    expect(rg.ssh[0]?.argv.at(-1)).toBe("powershell -NoProfile -NonInteractive -Command -");
  });

  test("the ssh call trusts only the pinned host key (StrictHostKeyChecking yes and a temporary known_hosts file)", async () => {
    const rg = rig({});
    await rg.run(external);
    const call = rg.ssh[0];
    expect(call.argv).toContain("StrictHostKeyChecking=yes");
    expect(call.argv).toContain("GlobalKnownHostsFile=/dev/null");
    expect(call.knownHosts).toBe(`nas.lan ${HOST_KEY}\n`);
    expect(call.mode).toBe(0o600);
    expect(existsSync(tempFiles[0])).toBe(false);
  });

  test("a port other than 22 is written in the known_hosts line with brackets", async () => {
    const rg = rig({});
    await rg.run({ ...external, port: "2222" });
    expect(rg.ssh[0]?.knownHosts).toBe(`[nas.lan]:2222 ${HOST_KEY}\n`);
  });

  test("the temporary known_hosts file is deleted when ssh fails", async () => {
    const rg = rig({}, { sshCode: 255, sshStderr: "boom" });
    await rejection(rg.run(external));
    expect(existsSync(tempFiles[0])).toBe(false);
  });

  test("a failed provision prints the ssh error text and leaves the target in draft", async () => {
    const rg = rig({}, { sshCode: 255, sshStderr: `Permission denied (publickey) for ${IDENTITY}` });
    const error = await rejection(rg.run(external));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("Permission denied (publickey)");
    expect(error.message).toContain("install");
    expect(error.message).toContain("draft");
    expect(error.message).not.toContain(IDENTITY);
    expect(rg.paths().some((path) => path.startsWith("DELETE"))).toBe(false);
    expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/test");
  });

  test("--no-test skips the test route", async () => {
    const rg = rig({});
    await rg.run({ ...external, "no-test": true });
    expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/test");
    expect(rg.out.at(-1)).toBe("key installed");
  });

  test("a test that fails exits 1 with the hub error and keeps the target", async () => {
    const rg = rig({ "POST /cli/api/ssh/targets/nas/test": () => ({ ok: false, error: "refused" }) });
    const error = await rejection(rg.run(external));
    expect(error.message).toContain("refused");
    expect(error.message).toContain("draft");
  });

  test("the identity path and the key text never appear in a request body to the hub", async () => {
    const rg = rig({});
    await rg.run(external);
    const text = JSON.stringify(rg.calls.map((call) => call.body ?? null));
    expect(text).not.toContain(IDENTITY);
    expect(text).not.toContain("secret-identity-file");
    expect(rg.out.join("\n")).not.toContain(IDENTITY);
  });
});

describe("sshTargetAdd managed local", () => {
  test("the usage text says that --managed local needs the LAN address of this machine", async () => {
    const error = await rejection(rig({}).run({ type: "linux" }));
    expect(error.message).toContain("--managed local needs --address");
    expect(error.message).toContain("LAN address of this machine as the other nodes see it");
  });

  test("the answer of the hub that the address is unknown reaches the owner", async () => {
    const text = "give the address of this host: the hub cannot tell it";
    const rg = rig({
      "POST /cli/api/ssh/targets": () => {
        throw new HubError(text, 400, undefined);
      },
    });
    const error = await rejection(rg.run({ ...managed, managed: "local" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain(text);
  });

  test("an explicit --address is sent with the managed host local", async () => {
    const rg = rig({});
    await rg.run({ ...managed, managed: "local", address: "192.168.1.5" });
    expect(bodyOf(rg.calls.find((call) => call.path.endsWith("/targets")))).toMatchObject({
      managedHost: "local",
      address: "192.168.1.5",
    });
  });
});

describe("sshTargetAdd managed", () => {
  test("a managed add calls the authorize route and runs no local ssh", async () => {
    const rg = rig({});
    await rg.run(managed);
    expect(rg.paths()).toContain("POST /cli/api/ssh/targets/nas/authorize");
    expect(rg.ssh).toEqual([]);
    expect(rg.calls[1]?.body).toEqual({
      id: "nas",
      systemType: "linux",
      account: "backup",
      nodes: ["pi"],
      managedHost: "nas-host",
    });
  });

  test("a managed add pins through pin-managed and asks no question", async () => {
    const rg = rig({});
    await rg.run(managed);
    expect(rg.paths()).toContain("POST /cli/api/ssh/targets/nas/pin-managed");
    expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/scan");
    expect(rg.prompts.filter((prompt) => prompt.includes("match"))).toEqual([]);
  });
});

describe("sshTargetAdd key file", () => {
  test("the usage text shows --key-file and the help text lists it", () => {
    expect(SSH_TARGET_USAGE).toContain("[--key-file <name>]");
  });

  test("--key-file is a flag that the parser reads", () => {
    const { flags } = parseCli(["ssh", "target", "add", "nas", "--managed", "pve", "--key-file", "authorized_keys2"]);
    expect(flags["key-file"]).toBe("authorized_keys2");
  });

  test("a managed add sends the key file to the hub", async () => {
    const rg = rig({});
    await rg.run({ ...managed, "key-file": "authorized_keys2" });
    expect(bodyOf(rg.calls.find((call) => call.path.endsWith("/targets")))).toMatchObject({
      managedHost: "nas-host",
      keyFile: "authorized_keys2",
    });
  });

  test("a managed add without --key-file sends no keyFile", async () => {
    const rg = rig({});
    await rg.run(managed);
    expect(bodyOf(rg.calls.find((call) => call.path.endsWith("/targets")))).not.toHaveProperty("keyFile");
  });

  test("target add of a managed linux target prints the key file", async () => {
    const rg = rig({
      "POST /cli/api/ssh/targets": () => ({ id: "nas", state: "draft", keyFile: "authorized_keys.claude-rc" }),
      "POST /cli/api/ssh/targets/nas/authorize": () => ({ ok: true, sshdCheck: "passed" }),
    });
    await rg.run(managed);
    expect(rg.out).toContain("key file: ~/.ssh/authorized_keys.claude-rc");
    expect(rg.out.filter((line) => line.startsWith("note:"))).toEqual([]);

    const plain = rig({});
    await plain.run(managed);
    expect(plain.out.filter((line) => line.startsWith("key file:"))).toEqual([]);
  });

  test("target add prints a note when the node skipped the sshd check", async () => {
    const rg = rig({
      "POST /cli/api/ssh/targets": () => ({ id: "nas", state: "draft", keyFile: "authorized_keys.claude-rc" }),
      "POST /cli/api/ssh/targets/nas/authorize": () => ({ ok: true, sshdCheck: "skipped" }),
    });
    await rg.run(managed);
    const note =
      "note: the node did not check that sshd reads ~/.ssh/authorized_keys.claude-rc. It is not root, or its version is older.";
    expect(rg.out).toContain(note);
    expect(rg.out.indexOf("key installed")).toBeLessThan(rg.out.indexOf(note));
  });

  test("a bad name, an external add, dropbear and windows exit 1 with the usage text and call nothing", async () => {
    const cases: Flags[] = [
      { ...managed, "key-file": "../x" },
      { ...managed, "key-file": "authorized_keys/../x" },
      { ...managed, "key-file": "known_hosts" },
      { ...managed, "key-file": "authorized_keys" + "a".repeat(49) },
      { ...managed, "key-file": "" },
      { ...external, "key-file": "authorized_keys2" },
      { ...managed, type: "dropbear", "key-file": "authorized_keys2" },
      { ...managed, type: "windows", "key-file": "authorized_keys2" },
    ];
    for (const flags of cases) {
      const rg = rig({});
      const error = await rejection(rg.run(flags));
      expect(exitCode(error)).toBe(1);
      expect(error.message).toStartWith(USAGE_START);
      expect(error.message).toContain("--key-file");
      expect(rg.calls).toEqual([]);
    }
  });
});

describe("sshTargetAdd unlock", () => {
  test("with the passphrase method the command asks for the passphrase and sends it with the key route", async () => {
    const rg = rig({}, { method: "passphrase" });
    await rg.run({ ...external, "no-test": false });
    const key = rg.calls.find((call) => call.path.endsWith("/key"));
    expect(key?.body).toEqual({
      unlock: { method: "passphrase", secret: Buffer.from("correct horse", "utf8").toString("base64url") },
    });
    expect(rg.secrets).toHaveLength(2);
    expect(rg.out.join("\n")).not.toContain("correct horse");
  });

  test("the test step asks again and sends the new unlock, which may differ from the first", async () => {
    const rg = rig({}, { method: "passphrase" });
    await rg.run(external);
    const test = rg.calls.find((call) => call.path.endsWith("/test"));
    expect(test?.body).toEqual({
      node: "pi",
      unlock: { method: "passphrase", secret: Buffer.from("second horse", "utf8").toString("base64url") },
    });
    expect(bodyOf(test).unlock).not.toEqual(bodyOf(rg.calls.find((call) => call.path.endsWith("/key"))).unlock);
  });

  test("with the passkey method the command prints the link and polls until the key exists", async () => {
    let polls = 0;
    const rg = rig(
      {
        "GET /cli/api/ssh/targets/nas": () => {
          polls += 1;
          return polls < 3
            ? { id: "nas", state: "draft" }
            : { id: "nas", state: "draft", keyFingerprint: FP, hostKey: HOST_KEY };
        },
      },
      { method: "prf" },
    );
    await rg.run({ ...external, "no-test": true });
    expect(rg.out).toContain(`open ${HUB}/ssh?target=nas to unlock with your passkey`);
    expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/key");
    expect(rg.sleeps).toEqual([2000, 2000]);
    expect(rg.out).toContain(`key created (${FP})`);
    expect(rg.secrets).toEqual([]);
  });

  test("the command exits 1 when the key does not exist after 10 minutes", async () => {
    const rg = rig({ "GET /cli/api/ssh/targets/nas": () => ({ id: "nas", state: "draft" }) }, { method: "prf" });
    const error = await rejection(rg.run(external));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("10 minutes");
    expect(error.message).toContain("draft");
    expect(rg.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(600_000);
    expect(rg.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(602_000);
  });

  test("with the passkey method the test step prints the link and polls until the target is ready", async () => {
    let ready = false;
    let after = 0;
    const rg = rig(
      {
        "GET /cli/api/ssh/targets/nas": () => {
          if (ready) after += 1;
          return { id: "nas", state: after >= 2 ? "ready" : "draft", keyFingerprint: FP, hostKey: HOST_KEY };
        },
      },
      { method: "prf" },
    );
    const run = rg.run(external, {
      runLocal: () => {
        ready = true;
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
    await run;
    expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/test");
    expect(rg.out.filter((line) => line.includes("/ssh?target=nas"))).toHaveLength(2);
    expect(rg.out.at(-1)).toBe("test passed: nas is ready");
  });
});

describe("sshTargetAdd fingerprint", () => {
  test("a fingerprint that differs from --fingerprint exits 1 and pins nothing", async () => {
    const rg = rig({});
    const error = await rejection(rg.run({ ...external, fingerprint: "SHA256:other" }));
    expect(exitCode(error)).toBe(1);
    expect(error.message).toContain("fingerprint");
    expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/pin");
    expect(rg.ssh).toEqual([]);
  });

  test("without --fingerprint the command asks, and an answer other than y exits 1 and pins nothing", async () => {
    const flags: Flags = { ...external };
    delete flags.fingerprint;

    for (const answer of ["", "n", "maybe"]) {
      const rg = rig({}, { answers: [answer] });
      const error = await rejection(rg.run(flags));
      expect(exitCode(error)).toBe(1);
      expect(rg.prompts).toContain("Do they match the target? [y/N] ");
      expect(rg.out).toContain(`host key ${FP}`);
      expect(rg.paths()).not.toContain("POST /cli/api/ssh/targets/nas/pin");
    }
  });

  test("without --fingerprint an answer of yes in any case pins", async () => {
    const flags: Flags = { ...external };
    delete flags.fingerprint;
    const rg = rig({}, { answers: ["YES"] });
    await rg.run(flags);
    const pin = rg.calls.find((call) => call.path.endsWith("/pin"));
    expect(pin?.body).toEqual({ hostKey: HOST_KEY });
  });
});
