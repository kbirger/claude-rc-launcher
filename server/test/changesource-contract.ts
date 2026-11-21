import { describe, expect, test } from "bun:test";
import { ACTIVE_ALL_MS, PASSIVE_ALL_MS, type ChangeSource, type Trigger } from "../src/changesource";
import { fakeTimers } from "./faketimers";

export function sourceContract(name: string, make: (t: ReturnType<typeof fakeTimers>) => { source: ChangeSource; change(): Promise<void> }): void {
  describe(name, () => {
    test("fires a trigger after a change", async () => {
      const t = fakeTimers();
      const { source, change } = make(t);
      const got: Trigger[] = [];
      source.start((x) => got.push(x));
      await change();
      await t.advance(PASSIVE_ALL_MS);
      expect(got.length).toBeGreaterThanOrEqual(1);
      source.stop();
    });

    test("fires nothing after stop()", async () => {
      const t = fakeTimers();
      const { source } = make(t);
      const got: Trigger[] = [];
      source.start((x) => got.push(x));
      source.stop();
      await t.advance(PASSIVE_ALL_MS * 2);
      expect(got).toEqual([]);
      expect(t.pending()).toBe(0);
    });

    test("setActive(true) makes triggers come sooner", async () => {
      const count = async (active: boolean) => {
        const t = fakeTimers();
        const { source, change } = make(t);
        let n = 0;
        source.start(() => n++);
        source.setActive(active);
        await change();
        await t.advance(ACTIVE_ALL_MS * 3);
        source.stop();
        return n;
      };
      expect(await count(true)).toBeGreaterThan(await count(false));
    });
  });
}
