import { describe, expect, test } from "bun:test";
import { passwdDirectory, USER_NAME_RE } from "../src/users";

const PASSWD = [
  "# comment",
  "root:x:0:0:root:/root:/bin/bash",
  "daemon:x:1:1::/usr/sbin:/usr/sbin/nologin",
  "alice:x:1000:1000::/home/alice:/bin/bash",
  "bob:x:1001:1001::/home/bob:/usr/sbin/nologin",
  "carol:x:1002:1002::/home/carol:/bin/false",
  "dave:x:1003:1003::/home/dave:/bin/bash",
  "claude-rc:x:999:998::/var/lib/claude-rc:/usr/sbin/nologin",
].join("\n");
const homeExists = async (h: string) => h !== "/home/dave";
const dir = (text = PASSWD) => passwdDirectory({ readPasswd: async () => text, homeExists });

describe("passwdDirectory", () => {
  test("lists root and uid>=1000 users with real shells", async () => {
    const users = await dir().list();
    expect(users.map((u) => u.name)).toEqual(["root", "alice"]);
    expect(users[1]).toEqual({ name: "alice", uid: 1000, gid: 1000, home: "/home/alice" });
  });

  test("get returns undefined for invalid and unknown names", async () => {
    const d = dir();
    expect((await d.get("alice"))?.uid).toBe(1000);
    for (const n of ["bob", "nobody", "a b", "x\ny", "a=b"]) expect(await d.get(n)).toBeUndefined();
  });

  test("skips malformed lines and comments", async () => {
    const d = dir("# x\n\nbroken\nfoo:x:abc:1::/home/foo:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/bash\n");
    expect((await d.list()).map((u) => u.name)).toEqual(["alice"]);
  });

  test("accepts dotted names and rejects unsafe ones", async () => {
    expect(USER_NAME_RE.test("john.doe")).toBe(true);
    for (const n of ["a b", "x\ny", "a=b"]) expect(USER_NAME_RE.test(n)).toBe(false);
    const d = dir("john.doe:x:1000:1000::/home/john.doe:/bin/bash\n");
    expect((await d.get("john.doe"))?.name).toBe("john.doe");
  });

  test("lookup finds a service account that fails the list rules", async () => {
    const d = dir();
    expect(await d.lookup("claude-rc")).toEqual({ name: "claude-rc", uid: 999, gid: 998, home: "/var/lib/claude-rc" });
    expect(await d.get("claude-rc")).toBeUndefined();
    expect((await d.list()).map((u) => u.name)).not.toContain("claude-rc");
    expect((await d.lookup("dave"))?.uid).toBe(1003);
  });

  test("lookup returns undefined for invalid and unknown names", async () => {
    const d = dir("broken\nfoo:x:abc:1::/home/foo:/bin/sh\n");
    for (const n of ["nobody", "a b", "x\ny", "a=b", "foo"]) expect(await d.lookup(n)).toBeUndefined();
  });
});
