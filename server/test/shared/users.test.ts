import { describe, expect, test } from "bun:test";
import { passwdDirectory, USER_NAME_RE } from "../../src/shared/users";

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
const homeExists = (item: string) => Promise.resolve(item !== "/home/dave");
const dir = (text = PASSWD) => passwdDirectory({ readPasswd: () => Promise.resolve(text), homeExists });

describe("passwdDirectory", () => {
  test("lists root and uid>=1000 users with real shells", async () => {
    const users = await dir().list();
    expect(users.map((systemUser) => systemUser.name)).toEqual(["root", "alice"]);
    expect(users[1]).toEqual({ name: "alice", uid: 1000, gid: 1000, home: "/home/alice" });
  });

  test("root is listed without the shell and home rules", async () => {
    const text =
      "root:x:0:0:root:/root:/usr/sbin/nologin\ntoor:x:0:0::/root:/usr/sbin/nologin\nalice:x:1000:1000::/home/alice:/bin/bash\n";
    const userDirectory = passwdDirectory({
      readPasswd: () => Promise.resolve(text),
      homeExists: (item) => Promise.resolve(item !== "/root"),
    });
    expect((await userDirectory.list()).map((systemUser) => systemUser.name)).toEqual(["root", "alice"]);
    expect(await userDirectory.get("root")).toEqual({ name: "root", uid: 0, gid: 0, home: "/root" });
    expect(await userDirectory.get("toor")).toBeUndefined();
  });

  test("get returns undefined for invalid and unknown names", async () => {
    const userDirectory = dir();
    expect((await userDirectory.get("alice"))?.uid).toBe(1000);
    for (const count of ["bob", "nobody", "a b", "x\ny", "a=b"]) expect(await userDirectory.get(count)).toBeUndefined();
  });

  test("skips malformed lines and comments", async () => {
    const userDirectory = dir(
      "# x\n\nbroken\nfoo:x:abc:1::/home/foo:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/bash\n",
    );
    expect((await userDirectory.list()).map((systemUser) => systemUser.name)).toEqual(["alice"]);
  });

  test("accepts dotted names and rejects unsafe ones", async () => {
    expect(USER_NAME_RE.test("john.doe")).toBe(true);
    for (const count of ["a b", "x\ny", "a=b"]) expect(USER_NAME_RE.test(count)).toBe(false);
    const userDirectory = dir("john.doe:x:1000:1000::/home/john.doe:/bin/bash\n");
    expect((await userDirectory.get("john.doe"))?.name).toBe("john.doe");
  });

  test("lookup finds a service account that fails the list rules", async () => {
    const userDirectory = dir();
    expect(await userDirectory.lookup("claude-rc")).toEqual({
      name: "claude-rc",
      uid: 999,
      gid: 998,
      home: "/var/lib/claude-rc",
    });
    expect(await userDirectory.get("claude-rc")).toBeUndefined();
    expect((await userDirectory.list()).map((systemUser) => systemUser.name)).not.toContain("claude-rc");
    expect((await userDirectory.lookup("dave"))?.uid).toBe(1003);
  });

  test("lookup returns undefined for invalid and unknown names", async () => {
    const userDirectory = dir("broken\nfoo:x:abc:1::/home/foo:/bin/sh\n");
    for (const count of ["nobody", "a b", "x\ny", "a=b", "foo"])
      expect(await userDirectory.lookup(count)).toBeUndefined();
  });
});
