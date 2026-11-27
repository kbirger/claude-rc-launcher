import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceCloner } from "../src/cloner";
import type { Config } from "../src/config/parse";
import { HttpError, InstanceService } from "../src/instances";
import type { Instances } from "../src/instances";
import type { RunOptions, Runner } from "../src/shared/runner";
import type { TrustStore } from "../src/trust";
import type { SystemUser, UserDirectory } from "../src/shared/users";
import { allTrusted } from "./helpers";
import { defined } from "./support";

const USERS: SystemUser[] = [
  { name: "root", uid: 0, gid: 0, home: "/root" },
  { name: "alice", uid: 1000, gid: 1001, home: "/home/alice" },
];
const SERVICE_ACCOUNT: SystemUser = { name: "svc", uid: 999, gid: 998, home: "/var/lib/svc" };
const users: UserDirectory = {
  list: () => Promise.resolve(USERS),
  get: (name) => Promise.resolve(USERS.find((systemUser) => systemUser.name === name)),
  lookup: (name) => Promise.resolve([...USERS, SERVICE_ACCOUNT].find((systemUser) => systemUser.name === name)),
};

function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: "hub",
    name: "t",
    hosts: [],
    stateDir: "/tmp",
    port: 1,
    host: "h",
    publicUrl: "http://x",
    roots: ["/srv"],
    scope: "system",
    unitDir: "/tmp/none",
    serviceUser: "root",
    serviceHome: "/root",
    servicePath: "/usr/bin",
    claudeBin: "/root/.local/bin/claude",
    claudeRcArgs: [],
    namePrefix: "",
    userAuth: {
      mode: "oidc",
      oidc: { issuer: "", clientId: "", clientSecret: "", allowInsecure: false },
      sessionSecret: "x".repeat(32),
    },
    ...over,
  };
}

/** A runner that records each call and answers the first gh call (`api user`) with an error, so repos() stops there. */
function recorder() {
  const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  const run: Runner = (cmd, args, opts) =>
    Promise.resolve((calls.push({ cmd, args, opts }), { code: 1, stdout: "", stderr: "stop" }));
  return { calls, run };
}

async function firstCall(
  config: Config,
  dirOwner: { uid: number; gid: number } | undefined,
  user?: string,
  canSwitchUser = true,
) {
  const harness = recorder();
  const instances = new InstanceService(config, harness.run, (entry) => Promise.resolve(entry), {
    users,
    trust: allTrusted,
    canSwitchUser,
  });
  const cloner = defined(serviceCloner(config, instances, dirOwner, harness.run));
  await cloner.repos(user).catch((error) => {
    if (!(error instanceof HttpError) || error.status !== 502) throw error;
  });
  return harness.calls[0];
}

describe("serviceCloner trust", () => {
  const ok = { code: 0, stdout: "", stderr: "" };

  async function cloneAs(
    config: Config,
    dirOwner: { uid: number; gid: number } | undefined,
    user: string | undefined,
    name: string,
  ) {
    const adds: { home: string; uid?: number; gid?: number; path: string }[] = [];
    const trust: TrustStore = {
      checker: () => Promise.resolve(() => false),
      add: (trustOwner, absPath) => {
        adds.push({ ...trustOwner, path: absPath });
        return Promise.resolve();
      },
    };
    const base = await realpath(await mkdtemp(join(tmpdir(), "svcclone-")));

    try {
      // A stub adoptDir changes no owner, so the test needs no root. It names the inode at the path, as the real one does.
      const adoptDir = async (path: string) => {
        const st = await lstat(path);
        return { dev: st.dev, ino: st.ino };
      };

      const cc = { ...config, roots: [base] };
      const instances = new InstanceService(cc, () => Promise.resolve(ok), undefined, {
        users,
        trust,
        canSwitchUser: true,
      });
      const cloner = defined(serviceCloner(cc, instances, dirOwner, () => Promise.resolve(ok), { adoptDir }));
      const started = await cloner.cloneStart({ repo: `octo/${name}`, parent: base, user });
      let st = await cloner.cloneStatus(started.id);

      for (let index = 0; index < 200 && st.state === "running"; index++) {
        await Bun.sleep(5);
        st = await cloner.cloneStatus(started.id);
      }

      return { adds, st, path: join(base, name) };
    } finally {
      await Bun.sleep(20);
      await rm(base, { recursive: true, force: true });
    }
  }

  test("root launcher with a non-root service user: trusts the clone for the service account", async () => {
    const config = cfg({ serviceUser: "svc", serviceHome: "/var/lib/svc" });
    const result = await cloneAs(
      config,
      { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      undefined,
      "proj",
    );
    expect(result.st.state).toBe("done");
    expect(result.adds).toEqual([{ home: "/var/lib/svc", uid: 999, gid: 998, path: result.path }]);
  });
  test("a named user: trusts the clone for that user's home, uid and gid", async () => {
    const result = await cloneAs(cfg({ serviceUser: "svc" }), undefined, "alice", "proj2");
    expect(result.st.state).toBe("done");
    expect(result.adds).toEqual([{ home: "/home/alice", uid: 1000, gid: 1001, path: result.path }]);
  });
});

describe("serviceCloner", () => {
  test("root launcher with a non-root service user: no user and the service user's name run as dirOwner", async () => {
    const config = cfg({ serviceUser: "svc", serviceHome: "/var/lib/svc", servicePath: "/usr/bin" });

    for (const item of [undefined, "svc"]) {
      const call = await firstCall(config, { uid: 999, gid: 998 }, item);
      expect(call.cmd).toMatch(/\/setpriv$/);
      expect(call.args.slice(0, 6)).toEqual(["--reuid", "999", "--regid", "998", "--init-groups", "--"]);
      expect(call.args.slice(6, 7)).toEqual(["gh"]);
      expect(call.opts?.env?.HOME).toBe("/var/lib/svc");
    }
  });

  test("root launcher with service user root: no setpriv", async () => {
    const call = await firstCall(cfg(), undefined);
    expect(call.cmd).toBe("gh");
    expect(call.opts?.env?.HOME).toBe("/root");
  });

  test("a named user runs as that user's uid and gid, not dirOwner", async () => {
    const call = await firstCall(cfg({ serviceUser: "svc" }), { uid: 999, gid: 998 }, "alice");
    expect(call.cmd).toMatch(/\/setpriv$/);
    expect(call.args.slice(0, 4)).toEqual(["--reuid", "1000", "--regid", "1001"]);
    expect(call.opts?.env?.HOME).toBe("/home/alice");
  });

  test("user scope cannot switch: a named user gives 400 and runs nothing", async () => {
    const config = cfg({ scope: "user" });
    const harness = recorder();
    const cloner = defined(
      serviceCloner(
        config,
        new InstanceService(config, harness.run, (value) => Promise.resolve(value), {
          users,
          trust: allTrusted,
          canSwitchUser: true,
        }),
        undefined,
        harness.run,
      ),
    );
    const entry = await cloner.repos("alice").then(
      () => undefined,
      (value) => value,
    );
    expect(entry).toBeInstanceOf(HttpError);
    expect((entry as HttpError).status).toBe(400);
    expect(harness.calls).toEqual([]);
  });

  test("a backend that is not InstanceService gives no cloner", () => {
    const instances = { list: () => Promise.resolve([]) } as unknown as Instances;
    expect(serviceCloner(cfg(), instances, undefined)).toBeUndefined();
  });
});
