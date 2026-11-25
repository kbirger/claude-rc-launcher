import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/instances";
import { grantConfig, sshConfigPath } from "../src/sshnodeapi";
import { newPipeName, currentUserSid } from "../src/win/pipe";
import {
  countEntries,
  ensurePrivateFolder,
  privateFolderArgs,
  removeStaleGrantFiles,
  runIcacls,
  writeGrantFile,
} from "../src/win/sshfiles";
import type { RunIcacls } from "../src/win/sshfiles";

const onWindows = process.platform === "win32";
const windowsTest = test.skipIf(!onWindows);
const SID = "S-1-5-21-1-2-3-1001";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "winsshfiles-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("paths in the config file", () => {
  test("a Linux path stays as it is", () => {
    expect(sshConfigPath("/run/claude-rc-ssh/a b/x.sock", false)).toBe("/run/claude-rc-ssh/a b/x.sock");
  });

  test("a Windows pipe name becomes the forward-slash form", () => {
    expect(sshConfigPath("\\\\.\\pipe\\claude-rc-agent-abc", true)).toBe("//./pipe/claude-rc-agent-abc");
  });

  test("a Windows path gets forward slashes", () => {
    expect(sshConfigPath("C:\\ProgramData\\claude-rc-launcher\\ssh\\i1\\g1.pub", true)).toBe(
      "C:/ProgramData/claude-rc-launcher/ssh/i1/g1.pub",
    );
  });

  test("a Windows path with a space gets double quotes", () => {
    expect(sshConfigPath("C:\\Users\\a b\\g.pub", true)).toBe('"C:/Users/a b/g.pub"');
  });

  test.each(['C:\\a"b', "C:\\a\nb", "C:\\a\rb", "C:\\a$HOME"])(
    "a Windows path with a quote, a line break or a dollar sign %p is refused",
    (path) => {
      expect(() => sshConfigPath(path, true)).toThrow();
    },
  );

  test("a percent sign is doubled, so it is not a token", () => {
    expect(sshConfigPath("C:\\100%\\x", true)).toBe("C:/100%%/x");
  });

  test("a single quote or a hash sign needs double quotes", () => {
    expect(sshConfigPath("C:\\Users\\O'Brien\\x", true)).toBe('"C:/Users/O\'Brien/x"');
    expect(sshConfigPath("C:\\c#dev\\x", true)).toBe('"C:/c#dev/x"');
  });
});

describe("the config text for a Windows node", () => {
  const input = {
    targetId: "kirhub",
    address: "192.168.1.111",
    port: 22,
    account: "kir",
    socket: "\\\\.\\pipe\\claude-rc-agent-abc",
    identity: "C:\\ProgramData\\claude-rc-launcher\\ssh\\i 1\\g1.pub",
    knownHosts: "C:\\ProgramData\\claude-rc-launcher\\ssh\\i 1\\g1.known_hosts",
  };

  test("holds the pipe in the forward-slash form and quotes a path with a space", () => {
    const text = grantConfig({ ...input, windows: true });
    expect(text).toContain("IdentityAgent //./pipe/claude-rc-agent-abc\n");
    expect(text).toContain('IdentityFile "C:/ProgramData/claude-rc-launcher/ssh/i 1/g1.pub"\n');
    expect(text).toContain('UserKnownHostsFile "C:/ProgramData/claude-rc-launcher/ssh/i 1/g1.known_hosts"\n');
    expect(text).toContain("IdentitiesOnly yes\n");
    expect(text).toContain("StrictHostKeyChecking yes\n");
    expect(text).not.toContain("\\");
  });

  test("the text for a Linux node does not change", () => {
    const text = grantConfig({ ...input, socket: "/run/x/g1.sock", identity: "/run/x/g1.pub", knownHosts: "/run/x/g1.kh" });
    expect(text).toContain("IdentityAgent /run/x/g1.sock\n");
    expect(text).toContain("IdentityFile /run/x/g1.pub\n");
    expect(text).toContain("UserKnownHostsFile /run/x/g1.kh\n");
  });

  windowsTest("ssh.exe reads a path with a quote, a hash sign and a percent sign whole", async () => {
    const folder = join(dir, "it's #1 100%");
    await mkdir(folder);
    const identity = join(folder, "g1.pub");
    const knownHosts = join(folder, "g1.known_hosts");
    const config = join(folder, "g1.config");
    await writeFile(config, grantConfig({ ...input, socket: newPipeName("agent"), identity, knownHosts, windows: true }));
    const sshExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    const proc = Bun.spawn([sshExe, "-G", "-F", config, "kirhub"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const lines = out.split(/\r?\n/);
    // `ssh -G` prints IdentityFile before it expands tokens, so the doubled percent sign shows. A real login
    // expands it to one percent sign (checked by hand with a local test server).
    const want = identity.replaceAll("\\", "/").replaceAll("%", "%%");
    expect(lines).toContain(`identityfile ${want}`);
    expect(lines.some((line) => line.startsWith("userknownhostsfile ") && line.endsWith("g1.known_hosts"))).toBe(true);
    expect(lines.find((line) => line.startsWith("userknownhostsfile "))).toContain("it's #1 100%");
  });

  windowsTest("ssh.exe reads the pipe and the paths from the config the way the node means", async () => {
    const folder = join(dir, "dir with space");
    await mkdir(folder);
    const pipe = newPipeName("agent");
    const identity = join(folder, "g1.pub");
    const knownHosts = join(folder, "g1.known_hosts");
    const config = join(folder, "g1.config");
    await writeFile(config, grantConfig({ ...input, socket: pipe, identity, knownHosts, windows: true }));
    const sshExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    const proc = Bun.spawn([sshExe, "-G", "-F", config, "kirhub"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const lines = out.split(/\r?\n/);
    expect(lines).toContain(`identityagent ${pipe.replaceAll("\\", "/")}`);
    expect(lines.some((line) => line.startsWith("identityfile ") && line.endsWith("g1.pub"))).toBe(true);
    expect(lines.some((line) => line.startsWith("userknownhostsfile ") && line.includes("dir with space"))).toBe(true);
    expect(lines).toContain("identitiesonly yes");
    expect(lines).toContain("stricthostkeychecking true");
  });
});

describe("the access list of a folder", () => {
  test("the icacls arguments grant SYSTEM, Administrators and one user, and remove inheritance", () => {
    expect(privateFolderArgs("C:\\x", SID)).toEqual([
      "C:\\x",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      `*${SID}:(OI)(CI)F`,
    ]);
  });

  test.each(["", "S-1", "S-1-5-1) /grant Everyone:F", "Everyone"])("the SID %p is refused", (sid) => {
    expect(() => privateFolderArgs("C:\\x", sid)).toThrow();
  });

  /** icacls output for a folder: the path, then one line for each entry. */
  const listing = (...names: string[]) =>
    `${dir} ${names.map((name, index) => `${index === 0 ? "" : "        "}${name}:(OI)(CI)(F)`).join("\n")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  const three = listing("NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators", "PC\\kir");

  test("countEntries counts the entries of icacls output", () => {
    expect(countEntries(three)).toBe(3);
    expect(countEntries(listing("A\\x", "B\\y", "C\\z", "Everyone"))).toBe(4);
    expect(countEntries("")).toBe(0);
  });

  test("ensurePrivateFolder makes the folder, sets the list and reads it back before it returns", async () => {
    const calls: string[][] = [];
    const run: RunIcacls = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, output: args.length === 1 ? three : "" });
    };
    const folder = join(dir, "top", "i1");
    await ensurePrivateFolder(folder, SID, run);
    expect(existsSync(folder)).toBe(true);
    expect(calls).toEqual([privateFolderArgs(folder, SID), [folder]]);
  });

  test("a failed icacls is an error that holds its output, and the new folder is removed", async () => {
    const run: RunIcacls = () => Promise.resolve({ code: 5, output: "Access is denied." });
    const folder = join(dir, "i1");
    await expect(ensurePrivateFolder(folder, SID, run)).rejects.toThrow("Access is denied.");
    expect(existsSync(folder)).toBe(false);
  });

  test("an extra entry in the list is refused and the new folder is removed", async () => {
    const run: RunIcacls = (args) =>
      Promise.resolve({ code: 0, output: args.length === 1 ? listing("A\\x", "B\\y", "C\\z", "Everyone") : "" });
    const folder = join(dir, "i1");
    await expect(ensurePrivateFolder(folder, SID, run)).rejects.toThrow("expected entries");
    expect(existsSync(folder)).toBe(false);
  });

  test("a folder that existed before stays when its list is refused", async () => {
    const folder = join(dir, "i1");
    await mkdir(folder);
    const run: RunIcacls = (args) =>
      Promise.resolve({ code: 0, output: args.length === 1 ? listing("A\\x", "Everyone") : "" });
    await expect(ensurePrivateFolder(folder, SID, run)).rejects.toThrow();
    expect(existsSync(folder)).toBe(true);
  });

  test.each(["relative\\folder", "\\\\server\\share\\x"])("the path %p is refused and icacls does not run", async (path) => {
    let ran = false;
    const run: RunIcacls = () => {
      ran = true;
      return Promise.resolve({ code: 0, output: "" });
    };
    await expect(ensurePrivateFolder(path, SID, run)).rejects.toThrow("local absolute path");
    expect(ran).toBe(false);
  });

  test("a file at the folder path is refused and icacls does not run", async () => {
    const path = join(dir, "i1");
    await writeFile(path, "x");
    let ran = false;
    const run: RunIcacls = () => {
      ran = true;
      return Promise.resolve({ code: 0, output: "" });
    };
    await expect(ensurePrivateFolder(path, SID, run)).rejects.toThrow();
    expect(ran).toBe(false);
  });

  windowsTest("a folder inside a private top folder inherits the list at once", async () => {
    const top = join(dir, "top with space");
    await ensurePrivateFolder(top, currentUserSid());
    const child = join(top, "i1");
    await mkdir(child);
    const text = (await runIcacls([child])).output;
    expect(countEntries(text)).toBe(3);
    expect(text).toContain("NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)");
    expect(text).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/);
    await ensurePrivateFolder(child, currentUserSid());
  });

  windowsTest("a folder with an extra entry for Everyone is refused on a second run", async () => {
    const folder = join(dir, "i1");
    await mkdir(folder);
    // The folder has an extra explicit entry. ensurePrivateFolder removes inheritance and replaces the three
    // entries, but the extra one stays, and the read-back finds four.
    expect((await runIcacls([folder, "/grant", "*S-1-1-0:(OI)(CI)R"])).code).toBe(0);
    await expect(ensurePrivateFolder(folder, currentUserSid())).rejects.toThrow("expected entries");
  });

  windowsTest("the real list is SYSTEM, Administrators and the user, and a new file inherits it", async () => {
    const folder = join(dir, "i1");
    await ensurePrivateFolder(folder, currentUserSid());
    const listing = (await runIcacls([folder])).output;
    expect(listing).toContain("NT AUTHORITY\\SYSTEM:(OI)(CI)(F)");
    expect(listing).toContain("BUILTIN\\Administrators:(OI)(CI)(F)");
    expect(listing).toContain(`${userInfo().username}:(OI)(CI)(F)`);
    expect(listing).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/);
    const file = join(folder, "g1.config");
    await writeGrantFile(file, "hello");
    const fileListing = (await runIcacls([file])).output;
    expect(fileListing).toContain("NT AUTHORITY\\SYSTEM:(I)(F)");
    expect(fileListing).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/);
    expect(await readFile(file, "utf8")).toBe("hello");
  });
});

describe("the grant files", () => {
  test("a file is written new", async () => {
    const path = join(dir, "g1.config");
    await writeGrantFile(path, "one");
    expect(await readFile(path, "utf8")).toBe("one");
  });

  test("a file that exists is replaced", async () => {
    const path = join(dir, "g1.config");
    await writeFile(path, "old");
    await writeGrantFile(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
  });

  test("an entry that is a folder is not replaced and gives an error", async () => {
    const path = join(dir, "g1.config");
    await mkdir(path);
    await expect(writeGrantFile(path, "x")).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  });

  test("the 409 error type is the one of the Linux node", () => {
    expect(new HttpError(409, "x").status).toBe(409);
  });
});

describe("files left by an earlier run", () => {
  test("the config, known_hosts and public key files go, and nothing else", async () => {
    await mkdir(join(dir, "i1"));
    await mkdir(join(dir, "i2"));
    for (const name of ["g1.config", "g1.known_hosts", "g1.pub", "notes.txt", "g1.sock"])
      await writeFile(join(dir, "i1", name), "x");
    await writeFile(join(dir, "i2", "g2.config"), "x");
    await writeFile(join(dir, "top-file.config"), "x");
    expect(await removeStaleGrantFiles(dir)).toBe(4);
    expect((await readdir(join(dir, "i1"))).sort()).toEqual(["g1.sock", "notes.txt"]);
    expect(await readdir(join(dir, "i2"))).toEqual([]);
    expect(existsSync(join(dir, "top-file.config"))).toBe(true);
  });

  test("an entry that cannot be removed is not counted", async () => {
    await mkdir(join(dir, "i1"));
    await mkdir(join(dir, "i1", "x.config"));
    await writeFile(join(dir, "i1", "g1.pub"), "x");
    expect(await removeStaleGrantFiles(dir)).toBe(1);
    expect(existsSync(join(dir, "i1", "x.config"))).toBe(true);
  });

  test("a top folder that does not exist gives 0", async () => {
    expect(await removeStaleGrantFiles(join(dir, "none"))).toBe(0);
  });
});
