import { describe, expect, test } from "vitest";
import { flushSync } from "svelte";
import { inRoot, reactive } from "../../../../test/effect-root.svelte";
import { createSectionsModel, DEFAULT_OPEN, loadOpen, SECTIONS_KEY, type Need } from "./sections.svelte";

// A Map-backed stand-in for localStorage.
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

function mount(storage: ReturnType<typeof memory> | undefined, needs: Need[] = []) {
  const props = reactive({ needs });
  const { value: model, dispose } = inRoot(() => createSectionsModel({ storage, needs: () => props.needs }));
  flushSync();
  return { model, props, dispose };
}

describe("loadOpen", () => {
  test("no saved value, a broken value or a throwing storage give the defaults", () => {
    expect(loadOpen(memory())).toEqual(DEFAULT_OPEN);
    expect(loadOpen(memory({ [SECTIONS_KEY]: "not json" }))).toEqual(DEFAULT_OPEN);
    expect(loadOpen(memory({ [SECTIONS_KEY]: '{"a":1}' }))).toEqual(DEFAULT_OPEN);
    expect(
      loadOpen({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
      }),
    ).toEqual(DEFAULT_OPEN);
    expect(loadOpen(undefined)).toEqual(DEFAULT_OPEN);
  });

  test("a saved value keeps only the known sections", () => {
    expect(loadOpen(memory({ [SECTIONS_KEY]: '["settings","nope",3]' }))).toEqual(["settings"]);
    expect(loadOpen(memory({ [SECTIONS_KEY]: "[]" }))).toEqual([]);
  });
});

describe("sections model", () => {
  test("by default Access requests and Targets are open, Nodes and Settings are closed", () => {
    const page = mount(memory());
    expect(page.model.open).toEqual(["requests", "targets"]);
    page.dispose();
  });

  test("a change by the owner is saved under one key and read back on the next mount", () => {
    const storage = memory();
    const first = mount(storage);
    first.model.setOpen(["settings"]);
    expect(first.model.open).toEqual(["settings"]);
    expect(JSON.parse(storage.items.get(SECTIONS_KEY)!)).toEqual(["settings"]);
    expect([...storage.items.keys()]).toEqual([SECTIONS_KEY]);
    first.dispose();
    const second = mount(storage);
    expect(second.model.open).toEqual(["settings"]);
    second.dispose();
  });

  test("a storage that throws on write still lets the owner open and close", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    const page = mount(storage as never);
    page.model.setOpen(["nodes"]);
    expect(page.model.open).toEqual(["nodes"]);
    page.dispose();
  });

  test("a need opens its section over a saved closed state", () => {
    const storage = memory({ [SECTIONS_KEY]: "[]" });
    const page = mount(storage, [{ section: "requests", token: "g1" }]);
    expect(page.model.open).toEqual(["requests"]);
    // The forced open is not a choice of the owner, so it is not saved.
    expect(storage.items.get(SECTIONS_KEY)).toBe("[]");
    page.dispose();
  });

  test("the owner can close a section that needs them, and the same need does not open it again", () => {
    const page = mount(memory({ [SECTIONS_KEY]: "[]" }), [{ section: "requests", token: "g1" }]);
    page.model.setOpen([]);
    expect(page.model.open).toEqual([]);
    // A refetch gives an equal list of needs: nothing changes.
    page.props.needs = [{ section: "requests", token: "g1" }];
    flushSync();
    expect(page.model.open).toEqual([]);
    page.dispose();
  });

  test("a new need opens the section again", () => {
    const page = mount(memory({ [SECTIONS_KEY]: "[]" }), [{ section: "requests", token: "g1" }]);
    page.model.setOpen([]);
    page.props.needs = [{ section: "requests", token: "g1,g2" }];
    flushSync();
    expect(page.model.open).toEqual(["requests"]);
    page.dispose();
  });

  test("a need adds its section to the ones that are open already", () => {
    const page = mount(memory({ [SECTIONS_KEY]: '["settings"]' }));
    page.props.needs = [{ section: "targets", token: "box" }];
    flushSync();
    expect(page.model.open).toEqual(["targets", "settings"]);
    page.dispose();
  });

  test("opening another section does not save a section that a need opened", () => {
    const storage = memory({ [SECTIONS_KEY]: "[]" });
    const page = mount(storage, [{ section: "requests", token: "g1" }]);
    page.model.setOpen(["requests", "settings"]);
    expect(page.model.open).toEqual(["requests", "settings"]);
    expect(JSON.parse(storage.items.get(SECTIONS_KEY)!)).toEqual(["settings"]);
    page.props.needs = [];
    flushSync();
    expect(page.model.open).toEqual(["settings"]);
    page.dispose();
  });
});
