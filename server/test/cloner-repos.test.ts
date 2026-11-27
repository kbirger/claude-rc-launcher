import { describe, expect, test } from "bun:test";
import { createCloner } from "../src/cloner";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import type { RunOptions, RunResult } from "../src/shared/runner";

const id = { home: "/home/u", path: "/usr/bin" };
interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const list = (...args: [string, boolean, string][]) =>
  JSON.stringify(args.map(([nameWithOwner, isPrivate, pushedAt]) => ({ nameWithOwner, isPrivate, pushedAt })));

function setup(
  handler: (args: string[]) => RunResult | Promise<RunResult>,
  identity: typeof id & { uid?: number; gid?: number } = id,
) {
  const calls: Call[] = [];
  const cloner = createCloner({
    cfg: { roots: [] } as unknown as Config,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return handler(cmd.endsWith("/setpriv") ? args.slice(args.indexOf("--") + 2) : args);
    },
    identityFor: () => Promise.resolve(identity),
  });
  return { cloner, calls };
}

async function fail(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }

  throw new Error("did not throw");
}

const owner = (item: string[]) => (item.includes("--") ? item[item.indexOf("--") + 1] : "");

describe("repos", () => {
  test("own account first, orgs alphabetical, repos newest first, empty orgs omitted", async () => {
    const { cloner, calls } = setup((args) => {
      if (args[0] === "api" && args[1] === "user") return ok("me\n");
      if (args[0] === "api") return ok("zeta\nAlpha\nempty\n");
      const entry = owner(args);
      if (entry === "")
        return ok(list(["me/old", false, "2020-01-01T00:00:00Z"], ["me/new", true, "2024-01-01T00:00:00Z"]));
      if (entry === "zeta") return ok(list(["zeta/z", false, "2023-01-01T00:00:00Z"]));
      if (entry === "Alpha")
        return ok(list(["Alpha/a1", false, "2021-01-01T00:00:00Z"], ["Alpha/a2", false, "2022-01-01T00:00:00Z"]));
      return ok("[]");
    });
    const out = await cloner.repos();
    expect(out.groups).toEqual([
      {
        owner: "me",
        repos: [
          { name: "me/new", private: true, pushedAt: "2024-01-01T00:00:00Z" },
          { name: "me/old", private: false, pushedAt: "2020-01-01T00:00:00Z" },
        ],
      },
      {
        owner: "Alpha",
        repos: [
          { name: "Alpha/a2", private: false, pushedAt: "2022-01-01T00:00:00Z" },
          { name: "Alpha/a1", private: false, pushedAt: "2021-01-01T00:00:00Z" },
        ],
      },
      { owner: "zeta", repos: [{ name: "zeta/z", private: false, pushedAt: "2023-01-01T00:00:00Z" }] },
    ]);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual(["api", "user", "--jq", ".login"]);
    expect(calls[1].args).toEqual(["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    expect(
      calls.some((call) => call.args.join(" ") === "repo list --limit 200 --json nameWithOwner,isPrivate,pushedAt"),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.args.join(" ") === "repo list --limit 200 --json nameWithOwner,isPrivate,pushedAt -- Alpha",
      ),
    ).toBe(true);
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
    expect(calls[0].opts?.env?.HOME).toBe("/home/u");
  });

  test("wraps gh in setpriv when the identity has a uid", async () => {
    const { cloner, calls } = setup((args) => (args[0] === "api" ? ok(args[1] === "user" ? "me" : "") : ok("[]")), {
      ...id,
      uid: 1001,
      gid: 1002,
    });
    await cloner.repos("bob");
    expect(calls[0].cmd).toMatch(/\/setpriv$/);
    expect(calls[0].args.slice(-5)).toEqual(["gh", "api", "user", "--jq", ".login"]);
  });

  test("exit 127 gives 500 gh is not installed", async () => {
    const { cloner } = setup(() => ({ code: 127, stdout: "", stderr: "" }));
    const httpError = await fail(cloner.repos());
    expect([httpError.status, httpError.message]).toEqual([500, "gh is not installed"]);
  });

  test("setpriv exit 127 with failed to execute names gh", async () => {
    const { cloner } = setup(() => ({ code: 127, stdout: "", stderr: "setpriv: failed to execute gh: No such file" }), {
      ...id,
      uid: 1,
      gid: 1,
    });
    expect((await fail(cloner.repos())).message).toBe("gh is not installed");
  });

  test("exit 4 and gh auth login stderr give 409 login required", async () => {
    for (const item of [
      { code: 4, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" },
    ]) {
      const { cloner } = setup(() => item);
      const httpError = await fail(cloner.repos());
      expect([httpError.status, httpError.message, httpError.extra]).toEqual([
        409,
        "GitHub login required",
        { code: "github-login-required" },
      ]);
    }
  });

  test("a failing org is skipped and logged, the rest survives", async () => {
    const errs: string[] = [];
    const orig = console.error;

    console.error = (...args: unknown[]) => {
      errs.push(args.join(" "));
    };

    try {
      const { cloner } = setup((args) => {
        if (args[0] === "api") return ok(args[1] === "user" ? "me" : "blocked\nfine\n");
        const entry = owner(args);
        if (entry === "blocked") return { code: 1, stdout: "", stderr: "OAuth App access restrictions\nmore" };
        return ok(list([`${entry || "me"}/r`, false, "2024-01-01T00:00:00Z"]));
      });
      const out = await cloner.repos();
      expect(out.groups.map((repoGroup) => repoGroup.owner)).toEqual(["me", "fine"]);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain("blocked");
      expect(errs[0]).toContain("OAuth App access restrictions");
      expect(errs[0]).not.toContain("more");
    } finally {
      console.error = orig;
    }
  });

  test("failure of the own list fails the call", async () => {
    const { cloner } = setup((args) => {
      if (args[0] === "api") return ok(args[1] === "user" ? "me" : "org1\n");
      return owner(args) === "" ? { code: 1, stdout: "", stderr: "boom" } : ok("[]");
    });
    expect((await fail(cloner.repos())).status).toBe(502);
  });

  test("non-JSON or wrong-shape output gives 502", async () => {
    for (const bad of ["not json", "{}", '[{"nameWithOwner":1}]']) {
      const { cloner } = setup((args) => (args[0] === "api" ? ok(args[1] === "user" ? "me" : "") : ok(bad)));
      const httpError = await fail(cloner.repos());
      expect([httpError.status, httpError.message]).toEqual([502, "unexpected output from gh"]);
    }
  });

  test("per-org calls run at most 4 at a time", async () => {
    let active = 0,
      peak = 0;
    const { cloner } = setup(async (args) => {
      if (args[0] === "api")
        return ok(args[1] === "user" ? "me" : Array.from({ length: 10 }, (_unused, entry) => `o${entry}`).join("\n"));
      if (owner(args) === "") return ok("[]");
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return ok("[]");
    });
    await cloner.repos();
    expect(peak).toBe(4);
  });

  test("null or missing pushedAt is listed last and does not fail", async () => {
    const raw = JSON.stringify([
      { nameWithOwner: "me/empty", isPrivate: false, pushedAt: null },
      { nameWithOwner: "me/none", isPrivate: false },
      { nameWithOwner: "me/pushed", isPrivate: true, pushedAt: "2024-01-01T00:00:00Z" },
    ]);
    const { cloner } = setup((args) => (args[0] === "api" ? ok(args[1] === "user" ? "me" : "") : ok(raw)));
    const out = await cloner.repos();
    expect(out.groups[0].repos.map((repo) => [repo.name, repo.pushedAt])).toEqual([
      ["me/pushed", "2024-01-01T00:00:00Z"],
      ["me/empty", ""],
      ["me/none", ""],
    ]);
  });

  test("other wrong shapes still give 502", async () => {
    for (const bad of [
      [{ nameWithOwner: "a/b", isPrivate: false, pushedAt: 5 }],
      [{ isPrivate: false, pushedAt: null }],
      [{ nameWithOwner: "a/b", isPrivate: "no", pushedAt: null }],
    ]) {
      const { cloner } = setup((args) =>
        args[0] === "api" ? ok(args[1] === "user" ? "me" : "") : ok(JSON.stringify(bad)),
      );
      expect((await fail(cloner.repos())).status).toBe(502);
    }
  });

  test("unparsable dates sort last, stable by name", async () => {
    const raw = list(
      ["me/z", false, "garbage"],
      ["me/a", false, ""],
      ["me/good", false, "2020-01-01T00:00:00Z"],
      ["me/m", false, "nope"],
    );
    const { cloner } = setup((args) => (args[0] === "api" ? ok(args[1] === "user" ? "me" : "") : ok(raw)));
    const out = await cloner.repos();
    expect(out.groups[0].repos.map((repo) => repo.name)).toEqual(["me/good", "me/a", "me/m", "me/z"]);
  });

  test("a login starting with a dash goes after --", async () => {
    const { cloner, calls } = setup((args) =>
      args[0] === "api" ? ok(args[1] === "user" ? "me" : "-evil\n") : ok("[]"),
    );
    await cloner.repos();
    expect(calls.some((call) => call.args.join(" ").endsWith("--json nameWithOwner,isPrivate,pushedAt -- -evil"))).toBe(
      true,
    );
  });

  test("an org-level 409 is skipped and logged", async () => {
    const errs: string[] = [];
    const orig = console.error;

    console.error = (...args: unknown[]) => {
      errs.push(args.join(" "));
    };

    try {
      const { cloner } = setup((args) => {
        if (args[0] === "api") return ok(args[1] === "user" ? "me" : "org1\n");
        return owner(args) === "org1"
          ? { code: 4, stdout: "", stderr: "" }
          : ok(list(["me/r", false, "2024-01-01T00:00:00Z"]));
      });
      expect((await cloner.repos()).groups.map((repoGroup) => repoGroup.owner)).toEqual(["me"]);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain("org1");
    } finally {
      console.error = orig;
    }
  });

  test("a 409 from the own list or from user/orgs fails the whole call", async () => {
    const own = setup((args) =>
      args[0] === "api" ? ok(args[1] === "user" ? "me" : "") : { code: 4, stdout: "", stderr: "" },
    );
    expect((await fail(own.cloner.repos())).status).toBe(409);
    const orgs = setup((args) =>
      args[0] === "api" && args[1] === "user/orgs" ? { code: 4, stdout: "", stderr: "" } : ok("me"),
    );
    expect((await fail(orgs.cloner.repos())).status).toBe(409);
  });

  test("an empty login gives 502", async () => {
    const { cloner } = setup(() => ok("\n"));
    const httpError = await fail(cloner.repos());
    expect([httpError.status, httpError.message]).toEqual([502, "unexpected output from gh"]);
  });

  test("a timed-out gh gives 504", async () => {
    const { cloner } = setup(() => ({ code: 143, stdout: "", stderr: "", timedOut: true }));
    const httpError = await fail(cloner.repos());
    expect([httpError.status, httpError.message]).toEqual([504, "gh timed out"]);
  });

  test("the whole list has a 100 s deadline: each gh call gets min(60 s, time left), then 504", async () => {
    let count = 0;
    const calls: Call[] = [];
    const cloner = createCloner({
      cfg: { roots: [] } as unknown as Config,
      now: () => count,
      run: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        count += 45_000;
        if (args[0] === "api") return Promise.resolve(ok(args[1] === "user" ? "me" : "org1\norg2\n"));
        return Promise.resolve(ok("[]"));
      },
      identityFor: () => Promise.resolve(id),
    });
    const httpError = await fail(cloner.repos());
    expect([httpError.status, httpError.message]).toEqual([504, "gh timed out"]);
    // api user at 0 s, user/orgs at 45 s, own list at 90 s; no time is left for the orgs.
    expect(calls.map((call) => call.opts?.timeoutMs)).toEqual([60_000, 55_000, 10_000]);
  });

  test("a deadline hit inside the org lists fails the call instead of giving a partial list", async () => {
    let count = 0;
    const cloner = createCloner({
      cfg: { roots: [] } as unknown as Config,
      now: () => count,
      run: (_cmd, args) => {
        if (args[0] === "api") return Promise.resolve(ok(args[1] === "user" ? "me" : "org1\n"));

        if (owner(args) === "") {
          count = 100_000;
          return Promise.resolve(ok("[]"));
        }

        return Promise.resolve(ok("[]"));
      },
      identityFor: () => Promise.resolve(id),
    });
    expect((await fail(cloner.repos())).status).toBe(504);
  });

  test("an org call that times out on the time left also fails the call", async () => {
    let count = 0;
    const cloner = createCloner({
      cfg: { roots: [] } as unknown as Config,
      now: () => count,
      run: (_cmd, args, opts) => {
        if (args[0] === "api") return Promise.resolve(ok(args[1] === "user" ? "me" : "org1\n"));

        if (owner(args) === "") {
          count = 90_000;
          return Promise.resolve(ok("[]"));
        }

        expect(opts?.timeoutMs).toBe(10_000);
        count = 100_000;
        return Promise.resolve({ code: 143, stdout: "", stderr: "", timedOut: true });
      },
      identityFor: () => Promise.resolve(id),
    });
    expect((await fail(cloner.repos())).status).toBe(504);
  });
});
