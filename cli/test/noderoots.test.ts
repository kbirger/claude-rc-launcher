import { describe, expect, test } from "bun:test";
import { ExitError } from "../src/creds";
import { addRoot, effectiveRoots, normalizeRoot, removeRoot, renderChecked } from "../src/noderoots";

describe("pure functions", () => {
  test("effectiveRoots falls back to the home of the service user", () => {
    expect(effectiveRoots({})).toEqual({ roots: ["/root"], implicit: true });
    expect(effectiveRoots({ instance: { service_user: "dev" } })).toEqual({ roots: ["/home/dev"], implicit: true });
  });

  test("effectiveRoots returns the configured roots", () => {
    expect(effectiveRoots({ instance: { service_home: "/srv/h", roots: ["/a"] } })).toEqual({
      roots: ["/a"],
      implicit: false,
    });
  });

  test("effectiveRoots uses service_home when there are no roots", () => {
    expect(effectiveRoots({ instance: { service_home: "/srv/h" } })).toEqual({ roots: ["/srv/h"], implicit: true });
  });

  test("normalizeRoot removes a trailing slash and keeps the root", () => {
    expect(normalizeRoot("/srv/p/")).toBe("/srv/p");
    expect(normalizeRoot("/")).toBe("/");
  });

  test("normalizeRoot rejects an empty, relative or .. path", () => {
    for (const bad of ["", "srv", "/a/../b"]) expect(() => normalizeRoot(bad)).toThrow(ExitError);
  });

  test("addRoot keeps the default root as the first root", () => {
    const result = addRoot({ instance: { service_user: "dev" } }, "/srv/p");
    expect(result.roots).toEqual(["/home/dev", "/srv/p"]);
    expect(result.seeded).toBe("/home/dev");
    expect(result.changed).toBe(true);
    expect(result.cfg).toEqual({ instance: { service_user: "dev", roots: ["/home/dev", "/srv/p"] } });
  });

  test("addRoot of an existing root changes nothing", () => {
    const cfg = { instance: { roots: ["/a", "/b"] } };
    const result = addRoot(cfg, "/b/");
    expect(result.changed).toBe(false);
    expect(result.cfg).toEqual(cfg);
    expect(result.seeded).toBeUndefined();
  });

  test("addRoot does not change its input", () => {
    const cfg = { instance: { roots: ["/a"] } };
    addRoot(cfg, "/b");
    expect(cfg).toEqual({ instance: { roots: ["/a"] } });
  });

  test("removeRoot refuses a folder that is not a root", () => {
    expect(() => removeRoot({ instance: { roots: ["/a", "/b"] } }, "/c")).toThrow(ExitError);
  });

  test("removeRoot refuses the last root", () => {
    expect(() => removeRoot({ instance: { roots: ["/a"] } }, "/a")).toThrow(ExitError);
  });

  test("removeRoot keeps the other root", () => {
    const result = removeRoot({ instance: { roots: ["/a", "/b"] } }, "/a");
    expect(result.roots).toEqual(["/b"]);
    expect(result.cfg).toEqual({ instance: { roots: ["/b"] } });
  });

  test("removeRoot can remove the default root once another root exists", () => {
    const added = addRoot({}, "/srv/p");
    expect(removeRoot(added.cfg, "/root").roots).toEqual(["/srv/p"]);
  });

  test("renderChecked keeps the other tables of the file", () => {
    const before = {
      mode: "node",
      tls: { names: ["a.internal"] },
      node_auth: { hub_key: [{ public_key: "k1" }, { public_key: "k2" }] },
    };
    const after = { ...before, instance: { roots: ["/a"] } };
    const text = renderChecked(before, after);
    expect(Bun.TOML.parse(text)).toEqual(after);
  });

  test("renderChecked refuses a change outside instance.roots", () => {
    const before = { tls: { names: ["a.internal"] }, instance: { roots: ["/a"] } };
    const after = { tls: { names: ["b.internal"] }, instance: { roots: ["/a", "/b"] } };
    expect(() => renderChecked(before, after)).toThrow(ExitError);
  });
});
