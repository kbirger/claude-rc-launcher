import { describe, expect, test } from "bun:test";
import { MAINTENANCE_BUSY } from "../src/sshservice";
import { TargetLocks } from "../src/sshtargetlocks";
import { TargetError } from "../src/sshtargets";

function locksWith(busy = new Set<string>()) {
  return new TargetLocks({ maintenanceFor: (id) => (busy.has(id) ? { id: "g1" } : undefined) });
}

async function refusal(work: Promise<unknown>): Promise<TargetError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TargetError) return error;
    throw error;
  }

  throw new Error("the work was not refused");
}

/** Starts `run` and gives a function that lets it end. */
function blocked() {
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    gate,
    release: () => {
      release();
    },
  };
}

describe("TargetLocks", () => {
  test("an idle target runs the work and frees the lock", async () => {
    const locks = locksWith();
    expect(await locks.run("edit", "t1", () => Promise.resolve(7))).toBe(7);
    expect(() => {
      locks.needIdle("t1");
    }).not.toThrow();
  });

  test("the lock is taken before the work awaits, and a second change gets 409", async () => {
    const locks = locksWith();
    const { gate, release } = blocked();
    const first = locks.run("edit", "t1", () => gate);
    const error = await refusal(locks.run("edit", "t1", () => Promise.resolve(undefined)));
    expect(error.status).toBe(409);
    expect(error.message).toBe("this target is being changed");
    release();
    await first;
  });

  test("each lock gives its own message, and a maintenance grant stays busy after the others end", async () => {
    const locks = locksWith(new Set(["t1"]));
    const retire = blocked();
    const edit = blocked();
    const retiring = locks.hold("retire", "t1", () => retire.gate);
    const editing = locks.hold("edit", "t2", () => edit.gate);

    expect(locks.isRetiring("t1")).toBe(true);
    expect(() => {
      locks.needIdle("t1");
    }).toThrow("this target is being retired");
    expect(() => {
      locks.needIdle("t2");
    }).toThrow("this target is being changed");
    expect(() => {
      locks.needIdle("t3");
    }).not.toThrow();
    retire.release();
    edit.release();
    await Promise.all([retiring, editing]);
    expect(() => {
      locks.needIdle("t1");
    }).toThrow(MAINTENANCE_BUSY);
  });

  test("hold does not look at the maintenance grant, but refuses a running request", async () => {
    const locks = locksWith(new Set(["t1"]));
    expect(await locks.hold("edit", "t1", () => Promise.resolve("ran"))).toBe("ran");
    const { gate, release } = blocked();
    const first = locks.run("retire", "t2", () => gate);
    const error = await refusal(locks.hold("edit", "t2", () => Promise.resolve(undefined)));
    expect(error.status).toBe(409);
    expect(error.message).toBe("the request is still being set up or another change runs: try again in a moment");
    release();
    await first;
  });

  test("the lock is freed when the work throws", async () => {
    const locks = locksWith();
    const error = await locks
      .run("retire", "t1", () => Promise.reject(new Error("boom")))
      .catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("boom"));
    expect(locks.isRetiring("t1")).toBe(false);
    expect(() => {
      locks.needIdle("t1");
    }).not.toThrow();
  });
});
