import { describe, expect, test } from "bun:test";
import { readRegisteredClients, registryPath, type RegistryIo } from "../src/installs";

const FILE = "/etc/claude-rc-launcher/installs";

type Over = { text?: string | Error; file?: { uid: number; mode: number } | undefined; dir?: { uid: number; mode: number } | undefined; platform?: string };
const GOOD = { uid: 0, mode: 0o100644 };
function io(o: Over = {}): RegistryIo {
  const has = (k: keyof Over) => k in o;
  const platform = o.platform ?? "linux";
  return {
    platform,
    env: {},
    readFile: () => {
      if (o.text instanceof Error) throw o.text;
      return o.text ?? "";
    },
    stat: (p) => (p.endsWith("installs") ? (has("file") ? o.file : GOOD) : has("dir") ? o.dir : { uid: 0, mode: 0o40755 }),
  };
}
const run = (o: Over) => {
  const logs: string[] = [];
  const r = readRegisteredClients(io(o), (l) => logs.push(l));
  return { r, logs };
};

describe("registryPath", () => {
  test("linux and others use /etc, win32 uses ProgramData", () => {
    expect(registryPath("linux", {})).toBe(FILE);
    expect(registryPath("darwin", {})).toBe(FILE);
    expect(registryPath("win32", { ProgramData: "D:\\PD" })).toBe("D:\\PD\\claude-rc-launcher\\installs");
    expect(registryPath("win32", {})).toBe("C:\\ProgramData\\claude-rc-launcher\\installs");
  });
});

describe("readRegisteredClients on linux", () => {
  test("a root-owned 0644 file gives its paths in order, without duplicates", () => {
    const { r, logs } = run({ text: "client /usr/local/bin/claude-rc\nclient /opt/x/claude-rc\nclient /usr/local/bin/claude-rc\n" });
    expect(r).toEqual(["/usr/local/bin/claude-rc", "/opt/x/claude-rc"]);
    expect(logs).toEqual([]);
  });

  test("group or world writable file gives [] and one log line naming the file", () => {
    for (const mode of [0o100664, 0o100666]) {
      const { r, logs } = run({ text: "client /usr/bin/claude-rc\n", file: { uid: 0, mode } });
      expect(r).toEqual([]);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain(FILE);
    }
  });

  test("a file owned by another user gives [] and a log line", () => {
    const { r, logs } = run({ text: "client /usr/bin/claude-rc\n", file: { uid: 1000, mode: 0o100644 } });
    expect(r).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(FILE);
  });

  test("a world-writable directory gives []", () => {
    const { r, logs } = run({ text: "client /usr/bin/claude-rc\n", dir: { uid: 0, mode: 0o40777 } });
    expect(r).toEqual([]);
    expect(logs.length).toBe(1);
  });

  test("a directory owned by another user gives []", () => {
    const { r } = run({ text: "client /usr/bin/claude-rc\n", dir: { uid: 1000, mode: 0o40755 } });
    expect(r).toEqual([]);
  });

  test("a missing file gives [] and no log line", () => {
    const { r, logs } = run({ file: undefined });
    expect(r).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a read error gives [] and a log line", () => {
    const { r, logs } = run({ text: new Error("EIO") });
    expect(r).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(FILE);
  });

  test("comments, blank lines and unknown kinds are ignored", () => {
    const { r } = run({ text: "# note\n\n  \ntool /x\nclient /usr/bin/claude-rc\r\n" });
    expect(r).toEqual(["/usr/bin/claude-rc"]);
  });

  test("invalid paths are ignored", () => {
    const text = ["client claude-rc", "client bin/claude-rc", "client /usr/bin/other", "client /a/../b/claude-rc", "client /usr/local/bin/", "client /usr/bin/CLAUDE-RC"].join("\n");
    expect(run({ text }).r).toEqual([]);
  });

  test("spaces inside the path are kept", () => {
    expect(run({ text: "client   /opt/my dir/claude-rc  \n" }).r).toEqual(["/opt/my dir/claude-rc"]);
  });
});

describe("readRegisteredClients on win32", () => {
  const win = (text: string, extra: Over = {}) => run({ platform: "win32", text, file: { uid: 1000, mode: 0o666 }, ...extra }).r;

  test("no owner or mode check; spaces and letter case are accepted", () => {
    expect(win("client C:\\Program Files\\claude-rc\\claude-rc.exe\nclient C:\\x\\CLAUDE-RC.EXE\n")).toEqual([
      "C:\\Program Files\\claude-rc\\claude-rc.exe",
      "C:\\x\\CLAUDE-RC.EXE",
    ]);
  });

  test("a name without .exe, a relative path and .. are ignored", () => {
    expect(win("client C:\\x\\claude-rc\nclient x\\claude-rc.exe\nclient C:\\a\\..\\b\\claude-rc.exe\nclient C:\\x\\\n")).toEqual([]);
  });

  test("duplicates differing in case are dropped", () => {
    expect(win("client C:\\x\\claude-rc.exe\nclient c:\\X\\CLAUDE-RC.EXE\n")).toEqual(["C:\\x\\claude-rc.exe"]);
  });

  test("a missing file gives []", () => {
    expect(win("client C:\\x\\claude-rc.exe\n", { file: undefined })).toEqual([]);
  });
});
