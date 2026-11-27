import { describe, expect, test } from "bun:test";
import { MANAGED_KEY_FILE } from "../../../src/ssh/constants";
import {
  DEFAULT_KEY_LIST,
  DROPIN_MARKER,
  DROPIN_PATH,
  MAIN_CONFIG_PATH,
  SshdDropin,
  SshdDropinError,
  dropinText,
  listHolds,
  parseKeyList,
} from "../../../src/ssh/node/SshdDropin";
import { FakeSshd } from "./fakesshd";

const NEW_LIST = "AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 .ssh/authorized_keys.claude-rc";

async function refusal(work: Promise<unknown>): Promise<SshdDropinError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SshdDropinError) return error;
    throw error;
  }

  throw new Error("the work was not refused");
}

describe("the pure functions", () => {
  test("parseKeyList reads the list of sshd -T", () => {
    const list = parseKeyList("port 22\nauthorizedkeysfile .ssh/authorized_keys /etc/ssh/claude-rc/%u\n");
    expect(list).toEqual([".ssh/authorized_keys", "/etc/ssh/claude-rc/%u"]);
  });

  test("parseKeyList gives the default list when sshd -T has no AuthorizedKeysFile line", () => {
    expect(parseKeyList("port 22\npasswordauthentication no\n")).toEqual(DEFAULT_KEY_LIST);
  });

  test("listHolds takes .ssh/<name>, %h/.ssh/<name> and the full path in the home", () => {
    expect(listHolds([".ssh/authorized_keys.claude-rc"], MANAGED_KEY_FILE)).toBe(true);
    expect(listHolds(["%h/.ssh/authorized_keys.claude-rc"], MANAGED_KEY_FILE)).toBe(true);
    expect(listHolds(["/home/alice/.ssh/authorized_keys.claude-rc"], MANAGED_KEY_FILE, "/home/alice")).toBe(true);
    expect(listHolds(["/home/alice/.ssh/authorized_keys.claude-rc"], MANAGED_KEY_FILE, "/home/alice/")).toBe(true);
  });

  test("listHolds refuses /etc/ssh/claude-rc/%u and a path in another home", () => {
    expect(listHolds(["/etc/ssh/claude-rc/%u"], MANAGED_KEY_FILE)).toBe(false);
    expect(listHolds(["/home/bob/.ssh/authorized_keys.claude-rc"], MANAGED_KEY_FILE, "/home/alice")).toBe(false);
    expect(listHolds(["/home/alice/.ssh/authorized_keys.claude-rc"], MANAGED_KEY_FILE)).toBe(false);
    expect(listHolds([".ssh/authorized_keys"], MANAGED_KEY_FILE)).toBe(false);
  });

  test("dropinText starts with the marker and repeats the list", () => {
    expect(dropinText([".ssh/authorized_keys", ".ssh/authorized_keys.claude-rc"])).toBe(
      `${DROPIN_MARKER}\nAuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.claude-rc\n`,
    );
  });
});

describe("SshdDropin.install", () => {
  test("install writes the old list and the new file", async () => {
    const fake = new FakeSshd();
    const result = await new SshdDropin(fake).install();
    expect(result).toEqual({
      kind: "installed",
      list: [...DEFAULT_KEY_LIST, ".ssh/authorized_keys.claude-rc"],
      reloaded: true,
    });
    expect(fake.files.get(DROPIN_PATH)).toBe(`${DROPIN_MARKER}\n${NEW_LIST}\n`);
    expect(fake.calls.filter((call) => call === "reloadSshd")).toHaveLength(1);
  });

  test("install does nothing when sshd reads the file already", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, "# mine\nAuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.claude-rc\n");
    const result = await new SshdDropin(fake).install();
    expect(result.kind).toBe("unchanged");
    expect(fake.changes()).toEqual([]);
    expect(fake.calls).not.toContain("reloadSshd");
  });

  test("install stops with not-root and names sudo claude-rc node sshd install", async () => {
    const fake = new FakeSshd();
    fake.root = false;
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("not-root");
    expect(error.message).toContain("sudo claude-rc node sshd install");
    expect(fake.calls.some((call) => call.startsWith("sshdEffective"))).toBe(false);
  });

  test("the root message uses the command of the caller", async () => {
    const fake = new FakeSshd();
    fake.root = false;
    const error = await refusal(new SshdDropin(fake, { command: "claude-rc-launcher sshd-dropin" }).check());
    expect(error.message).toContain("sudo claude-rc-launcher sshd-dropin check");
  });

  test("install stops with no-sshd", async () => {
    const fake = new FakeSshd();
    fake.effective = () => undefined;
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("no-sshd");
    expect(fake.changes()).toEqual([]);
  });

  test("install stops with sshd-failed and gives the stderr", async () => {
    const fake = new FakeSshd();
    fake.effective = () => ({ code: 255, stdout: "", stderr: "Bad configuration option: Foo" });
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("sshd-failed");
    expect(error.message).toContain("Bad configuration option: Foo");
    expect(fake.changes()).toEqual([]);
  });

  test("install stops with no-include", async () => {
    const fake = new FakeSshd();
    fake.files.set(MAIN_CONFIG_PATH, "Port 22\n# Include /etc/ssh/sshd_config.d/*.conf\n");
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("no-include");
    expect(fake.changes()).toEqual([]);
  });

  test("install stops with keys-off", async () => {
    const fake = new FakeSshd();
    fake.baseList = ["none"];
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("keys-off");
    expect(fake.changes()).toEqual([]);
  });

  test("install stops with unmanaged-file and names the line to add", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, "AuthorizedKeysFile .ssh/authorized_keys\n");
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("unmanaged-file");
    expect(error.message).toContain(DROPIN_PATH);
    expect(error.message).toContain(".ssh/authorized_keys.claude-rc");
    expect(fake.changes()).toEqual([]);
  });

  test("install removes the drop-in when sshd -t fails", async () => {
    const fake = new FakeSshd();
    fake.testAnswer = { code: 255, stdout: "", stderr: "line 2: bad value" };
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("test-failed");
    expect(error.message).toContain("line 2: bad value");
    expect(fake.files.has(DROPIN_PATH)).toBe(false);
    expect(fake.calls).not.toContain("reloadSshd");
  });

  test("install puts back the old managed file when sshd -t fails", async () => {
    const fake = new FakeSshd();
    const old = `${DROPIN_MARKER}\nAuthorizedKeysFile .ssh/authorized_keys\n`;
    fake.files.set(DROPIN_PATH, old);
    fake.testAnswer = { code: 255, stdout: "", stderr: "bad" };
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("test-failed");
    expect(fake.files.get(DROPIN_PATH)).toBe(old);
  });

  test("install removes the drop-in when another file sets AuthorizedKeysFile first", async () => {
    const fake = new FakeSshd();
    fake.dropinCounts = false;
    const error = await refusal(new SshdDropin(fake).install());
    expect(error.code).toBe("not-effective");
    expect(error.message).toContain(".ssh/authorized_keys .ssh/authorized_keys2");
    expect(fake.files.has(DROPIN_PATH)).toBe(false);
    expect(fake.calls).not.toContain("reloadSshd");
  });

  test("install succeeds with a note when the reload fails", async () => {
    const fake = new FakeSshd();
    fake.reloadAnswer = { ok: false, detail: "no ssh or sshd unit" };
    const result = await new SshdDropin(fake).install();
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") return;
    expect(result.reloaded).toBe(false);
    expect(result.note).toContain("socket");
    expect(fake.files.get(DROPIN_PATH)).toBe(`${DROPIN_MARKER}\n${NEW_LIST}\n`);
  });

  test("install twice writes once", async () => {
    const fake = new FakeSshd();
    const dropin = new SshdDropin(fake);
    await dropin.install();
    const second = await dropin.install();
    expect(second.kind).toBe("unchanged");
    expect(fake.changes()).toEqual([`writeFile ${DROPIN_PATH}`]);
  });

  test("install uses the paths of the options", async () => {
    const fake = new FakeSshd();
    fake.files.delete(MAIN_CONFIG_PATH);
    fake.files.set("/fake/main", "Include /etc/ssh/sshd_config.d/*.conf\n");

    fake.effective = (machine) => {
      const list = machine.files.has("/fake/dropin")
        ? ".ssh/authorized_keys .ssh/authorized_keys.claude-rc"
        : ".ssh/authorized_keys";
      return { code: 0, stdout: `authorizedkeysfile ${list}\n`, stderr: "" };
    };

    const dropin = new SshdDropin(fake, { dropinPath: "/fake/dropin", mainConfigPath: "/fake/main" });
    await dropin.install();
    expect(fake.files.get("/fake/dropin")).toBe(
      `${DROPIN_MARKER}\nAuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.claude-rc\n`,
    );
    expect(fake.files.has(DROPIN_PATH)).toBe(false);
  });
});

describe("SshdDropin.remove", () => {
  test("remove deletes only a file with the marker", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${NEW_LIST}\n`);
    expect(await new SshdDropin(fake).remove()).toBe("removed");
    expect(fake.files.has(DROPIN_PATH)).toBe(false);
    expect(fake.calls).toContain("sshdTest");
    expect(fake.calls).toContain("reloadSshd");

    const other = new FakeSshd();
    other.files.set(DROPIN_PATH, "AuthorizedKeysFile .ssh/authorized_keys\n");
    const error = await refusal(new SshdDropin(other).remove());
    expect(error.code).toBe("unmanaged-file");
    expect(other.files.has(DROPIN_PATH)).toBe(true);
    expect(other.changes()).toEqual([]);
  });

  test("remove of a missing file answers absent", async () => {
    const fake = new FakeSshd();
    expect(await new SshdDropin(fake).remove()).toBe("absent");
    expect(fake.changes()).toEqual([]);
  });

  test("remove puts the file back when sshd -t fails", async () => {
    const fake = new FakeSshd();
    const text = `${DROPIN_MARKER}\n${NEW_LIST}\n`;
    fake.files.set(DROPIN_PATH, text);
    fake.testAnswer = { code: 255, stdout: "", stderr: "broken" };
    const error = await refusal(new SshdDropin(fake).remove());
    expect(error.code).toBe("test-failed");
    expect(error.message).toContain("broken");
    expect(fake.files.get(DROPIN_PATH)).toBe(text);
    expect(fake.calls).not.toContain("reloadSshd");
  });

  test("remove needs root", async () => {
    const fake = new FakeSshd();
    fake.root = false;
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${NEW_LIST}\n`);
    const error = await refusal(new SshdDropin(fake).remove());
    expect(error.code).toBe("not-root");
    expect(error.message).toContain("sudo claude-rc node sshd remove");
    expect(fake.changes()).toEqual([]);
  });
});

describe("SshdDropin.check and readsFor", () => {
  test("check reports the drop-in state and whether sshd reads the file", async () => {
    const absent = new FakeSshd();
    expect(await new SshdDropin(absent).check()).toEqual({ reads: false, list: DEFAULT_KEY_LIST, dropin: "absent" });

    const managed = new FakeSshd();
    managed.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${NEW_LIST}\n`);
    expect(await new SshdDropin(managed).check()).toEqual({
      reads: true,
      list: [...DEFAULT_KEY_LIST, ".ssh/authorized_keys.claude-rc"],
      dropin: "managed",
    });

    const unmanaged = new FakeSshd();
    unmanaged.files.set(DROPIN_PATH, "AuthorizedKeysFile .ssh/authorized_keys\n");
    expect(await new SshdDropin(unmanaged).check()).toEqual({
      reads: false,
      list: [".ssh/authorized_keys"],
      dropin: "unmanaged",
    });
    expect(unmanaged.changes()).toEqual([]);
  });

  test("check needs root", async () => {
    const fake = new FakeSshd();
    fake.root = false;
    const error = await refusal(new SshdDropin(fake).check());
    expect(error.code).toBe("not-root");
    expect(error.message).toContain("sudo claude-rc node sshd check");
  });

  test("readsFor runs sshd -T for the account", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${NEW_LIST}\n`);
    expect(await new SshdDropin(fake).readsFor("alice", "/home/alice", MANAGED_KEY_FILE)).toBe(true);
    expect(fake.calls).toContain("sshdEffective alice");
  });

  test("readsFor takes the full path in the home of the account", async () => {
    const fake = new FakeSshd();
    fake.accountLists.set("alice", ["/home/alice/.ssh/authorized_keys.claude-rc"]);
    expect(await new SshdDropin(fake).readsFor("alice", "/home/alice", MANAGED_KEY_FILE)).toBe(true);
  });

  test("readsFor is false when a Match block gives the account another list", async () => {
    const fake = new FakeSshd();
    fake.files.set(DROPIN_PATH, `${DROPIN_MARKER}\n${NEW_LIST}\n`);
    fake.accountLists.set("alice", ["/etc/ssh/claude-rc/%u"]);
    expect(await new SshdDropin(fake).readsFor("alice", "/home/alice", MANAGED_KEY_FILE)).toBe(false);
  });
});
