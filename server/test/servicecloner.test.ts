import { describe, expect, test } from "bun:test";
import { serviceCloner } from "../src/cloner";
import type { Config } from "../src/config";
import { HttpError, InstanceService, type Instances } from "../src/instances";
import type { RunOptions, Runner } from "../src/runner";
import type { SystemUser, UserDirectory } from "../src/users";
import { allTrusted } from "./helpers";

const USERS: SystemUser[] = [
  { name: "root", uid: 0, gid: 0, home: "/root" },
  { name: "alice", uid: 1000, gid: 1001, home: "/home/alice" },
];
const SERVICE_ACCOUNT: SystemUser = { name: "svc", uid: 999, gid: 998, home: "/var/lib/svc" };
const users: UserDirectory = {
  list: async () => USERS,
  get: async (n) => USERS.find((u) => u.name === n),
  lookup: async (n) => [...USERS, SERVICE_ACCOUNT].find((u) => u.name === n),
};
function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: "hub", name: "t", hosts: [], stateDir: "/tmp", port: 1, host: "h", publicUrl: "http://x", roots: ["/srv"], scope: "system", unitDir: "/tmp/none",
    serviceUser: "root", serviceHome: "/root", servicePath: "/usr/bin", claudeBin: "/root/.local/bin/claude",
    claudeRcArgs: [], namePrefix: "",
    userAuth: { mode: "oidc", oidc: { issuer: "", clientId: "", clientSecret: "", allowInsecure: false }, sessionSecret: "x".repeat(32) }, ...over,
  } as Config;
}
/** A runner that records each call and answers the first gh call (`api user`) with an error, so repos() stops there. */
function recorder() {
  const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  const run: Runner = async (cmd, args, opts) => (calls.push({ cmd, args, opts }), { code: 1, stdout: "", stderr: "stop" });
  return { calls, run };
}
async function firstCall(c: Config, dirOwner: { uid: number; gid: number } | undefined, user?: string, canSwitchUser = true) {
  const r = recorder();
  const instances = new InstanceService(c, r.run, async (p) => p, { users, trust: allTrusted, canSwitchUser });
  const cloner = serviceCloner(c, instances, dirOwner, r.run)!;
  await cloner.repos(user).catch((e) => { if (!(e instanceof HttpError) || e.status !== 502) throw e; });
  return r.calls[0]!;
}

describe("serviceCloner", () => {
  test("root launcher with a non-root service user: no user and the service user's name run as dirOwner", async () => {
    const c = cfg({ serviceUser: "svc", serviceHome: "/var/lib/svc", servicePath: "/usr/bin" });
    for (const u of [undefined, "svc"]) {
      const call = await firstCall(c, { uid: 999, gid: 998 }, u);
      expect(call.cmd).toBe("setpriv");
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
    expect(call.cmd).toBe("setpriv");
    expect(call.args.slice(0, 4)).toEqual(["--reuid", "1000", "--regid", "1001"]);
    expect(call.opts?.env?.HOME).toBe("/home/alice");
  });

  test("user scope cannot switch: a named user gives 400 and runs nothing", async () => {
    const c = cfg({ scope: "user" });
    const r = recorder();
    const cloner = serviceCloner(c, new InstanceService(c, r.run, async (p) => p, { users, trust: allTrusted, canSwitchUser: true }), undefined, r.run)!;
    const e = await cloner.repos("alice").then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    expect(r.calls).toEqual([]);
  });

  test("a backend that is not InstanceService gives no cloner", () => {
    const other = { list: async () => [] } as unknown as Instances;
    expect(serviceCloner(cfg(), other, undefined)).toBeUndefined();
  });
});
