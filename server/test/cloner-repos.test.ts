import { describe, expect, test } from "bun:test";
import { createCloner } from "../src/cloner";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import type { RunOptions, RunResult } from "../src/runner";

const id = { home: "/home/u", path: "/usr/bin" };
type Call = { cmd: string; args: string[]; opts?: RunOptions };
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const list = (...r: [string, boolean, string][]) =>
  JSON.stringify(r.map(([nameWithOwner, isPrivate, pushedAt]) => ({ nameWithOwner, isPrivate, pushedAt })));

function setup(handler: (args: string[]) => RunResult | Promise<RunResult>, identity: typeof id & { uid?: number; gid?: number } = id) {
  const calls: Call[] = [];
  const cloner = createCloner({
    cfg: { roots: [] } as unknown as Config,
    run: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return handler(cmd === "setpriv" ? args.slice(args.indexOf("--") + 2) : args); },
    identityFor: async () => identity,
  });
  return { cloner, calls };
}
async function fail(p: Promise<unknown>): Promise<HttpError> {
  try { await p; } catch (e) { if (e instanceof HttpError) return e; throw e; }
  throw new Error("did not throw");
}
const owner = (a: string[]) => (a[2].startsWith("--") ? "" : a[2]);

describe("repos", () => {
  test("own account first, orgs alphabetical, repos newest first, empty orgs omitted", async () => {
    const { cloner, calls } = setup((a) => {
      if (a[0] === "api" && a[1] === "user") return ok("me\n");
      if (a[0] === "api") return ok("zeta\nAlpha\nempty\n");
      const o = owner(a);
      if (o === "") return ok(list(["me/old", false, "2020-01-01T00:00:00Z"], ["me/new", true, "2024-01-01T00:00:00Z"]));
      if (o === "zeta") return ok(list(["zeta/z", false, "2023-01-01T00:00:00Z"]));
      if (o === "Alpha") return ok(list(["Alpha/a1", false, "2021-01-01T00:00:00Z"], ["Alpha/a2", false, "2022-01-01T00:00:00Z"]));
      return ok("[]");
    });
    const out = await cloner.repos();
    expect(out.groups).toEqual([
      { owner: "me", repos: [{ name: "me/new", private: true, pushedAt: "2024-01-01T00:00:00Z" }, { name: "me/old", private: false, pushedAt: "2020-01-01T00:00:00Z" }] },
      { owner: "Alpha", repos: [{ name: "Alpha/a2", private: false, pushedAt: "2022-01-01T00:00:00Z" }, { name: "Alpha/a1", private: false, pushedAt: "2021-01-01T00:00:00Z" }] },
      { owner: "zeta", repos: [{ name: "zeta/z", private: false, pushedAt: "2023-01-01T00:00:00Z" }] },
    ]);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual(["api", "user", "--jq", ".login"]);
    expect(calls[1].args).toEqual(["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    expect(calls.some((c) => c.args.join(" ") === "repo list --limit 200 --json nameWithOwner,isPrivate,pushedAt")).toBe(true);
    expect(calls.some((c) => c.args.join(" ") === "repo list Alpha --limit 200 --json nameWithOwner,isPrivate,pushedAt")).toBe(true);
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
    expect(calls[0].opts?.env?.HOME).toBe("/home/u");
  });

  test("wraps gh in setpriv when the identity has a uid", async () => {
    const { cloner, calls } = setup((a) => (a[0] === "api" ? ok(a[1] === "user" ? "me" : "") : ok("[]")), { ...id, uid: 1001, gid: 1002 });
    await cloner.repos("bob");
    expect(calls[0].cmd).toBe("setpriv");
    expect(calls[0].args.slice(-5)).toEqual(["gh", "api", "user", "--jq", ".login"]);
  });

  test("exit 127 gives 500 gh is not installed", async () => {
    const { cloner } = setup(() => ({ code: 127, stdout: "", stderr: "" }));
    const e = await fail(cloner.repos());
    expect([e.status, e.message]).toEqual([500, "gh is not installed"]);
  });

  test("setpriv exit 127 with failed to execute names gh", async () => {
    const { cloner } = setup(() => ({ code: 127, stdout: "", stderr: "setpriv: failed to execute gh: No such file" }), { ...id, uid: 1, gid: 1 });
    expect((await fail(cloner.repos())).message).toBe("gh is not installed");
  });

  test("exit 4 and gh auth login stderr give 409 login required", async () => {
    for (const r of [{ code: 4, stdout: "", stderr: "" }, { code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }]) {
      const { cloner } = setup(() => r);
      const e = await fail(cloner.repos());
      expect([e.status, e.message, e.extra]).toEqual([409, "GitHub login required", { code: "github-login-required" }]);
    }
  });

  test("a failing org is skipped and logged, the rest survives", async () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
    try {
      const { cloner } = setup((a) => {
        if (a[0] === "api") return ok(a[1] === "user" ? "me" : "blocked\nfine\n");
        const o = owner(a);
        if (o === "blocked") return { code: 1, stdout: "", stderr: "OAuth App access restrictions\nmore" };
        return ok(list([`${o || "me"}/r`, false, "2024-01-01T00:00:00Z"]));
      });
      const out = await cloner.repos();
      expect(out.groups.map((g) => g.owner)).toEqual(["me", "fine"]);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain("blocked");
      expect(errs[0]).toContain("OAuth App access restrictions");
      expect(errs[0]).not.toContain("more");
    } finally { console.error = orig; }
  });

  test("failure of the own list fails the call", async () => {
    const { cloner } = setup((a) => {
      if (a[0] === "api") return ok(a[1] === "user" ? "me" : "org1\n");
      return owner(a) === "" ? { code: 1, stdout: "", stderr: "boom" } : ok("[]");
    });
    expect((await fail(cloner.repos())).status).toBe(502);
  });

  test("non-JSON or wrong-shape output gives 502", async () => {
    for (const bad of ["not json", "{}", '[{"nameWithOwner":1}]']) {
      const { cloner } = setup((a) => (a[0] === "api" ? ok(a[1] === "user" ? "me" : "") : ok(bad)));
      const e = await fail(cloner.repos());
      expect([e.status, e.message]).toEqual([502, "unexpected output from gh"]);
    }
  });

  test("per-org calls run at most 4 at a time", async () => {
    let active = 0, peak = 0;
    const { cloner } = setup(async (a) => {
      if (a[0] === "api") return ok(a[1] === "user" ? "me" : Array.from({ length: 10 }, (_, i) => `o${i}`).join("\n"));
      if (owner(a) === "") return ok("[]");
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return ok("[]");
    });
    await cloner.repos();
    expect(peak).toBe(4);
  });
});
