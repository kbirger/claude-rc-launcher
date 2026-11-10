import { beforeEach, describe, expect, test } from "bun:test";
import { readRegisteredClients, registryPath, resetRegistryLog, type RegQueryResult, type RegistryIo } from "../src/installs";

beforeEach(() => resetRegistryLog());

const FILE = "/etc/claude-rc-launcher/installs";
const DIR = "/etc/claude-rc-launcher";

type St = { uid: any; mode: any } | undefined;
const REG: St = { uid: 0, mode: 0o100644 };
const DIRST: St = { uid: 0, mode: 0o040755 };

type Over = { text?: any; stats?: Record<string, St>; platform?: string; reg?: RegQueryResult };
function io(o: Over = {}): RegistryIo {
  const platform = o.platform ?? "linux";
  const stats: Record<string, St> = o.stats ?? { [FILE]: REG, [DIR]: DIRST };
  return {
    platform,
    env: {},
    readFile: () => {
      if (o.text instanceof Error) throw o.text;
      return o.text ?? "";
    },
    stat: (p) => stats[p],
    regQuery: o.reg ? () => o.reg! : undefined,
  };
}
const run = (o: Over) => {
  const logs: string[] = [];
  const r = readRegisteredClients(io(o), (l) => logs.push(l));
  return { r, logs };
};
const ok = "client /usr/bin/claude-rc\n";
const withFile = (f: St, ...d: [St?]) => ({ stats: { [FILE]: f, [DIR]: d.length ? d[0] : DIRST } });
const refused = (o: Over) => {
  resetRegistryLog(); // several cases in one test log the same message
  const { r, logs } = run({ text: ok, ...o });
  expect(r).toEqual([]);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain(FILE);
};

describe("registryPath", () => {
  test("it is the Linux path", () => {
    expect(registryPath("linux", {})).toBe(FILE);
    expect(registryPath("darwin", {})).toBe(FILE);
  });
});

describe("readRegisteredClients on linux", () => {
  test("a root-owned 0644 file gives its paths in order, without duplicates", () => {
    const { r, logs } = run({ text: "client /usr/local/bin/claude-rc\nclient /opt/x/claude-rc\nclient /usr/local/bin/claude-rc\n" });
    expect(r).toEqual(["/usr/local/bin/claude-rc", "/opt/x/claude-rc"]);
    expect(logs).toEqual([]);
  });

  test("any group or world write bit on the file gives [] and one log line naming the file", () => {
    for (const mode of [0o100664, 0o100666, 0o100620, 0o100602]) refused(withFile({ uid: 0, mode }));
  });

  test("a file owned by another user gives []", () => refused(withFile({ uid: 1000, mode: 0o100644 })));

  test("group or world writable directory gives []", () => {
    refused(withFile(REG, { uid: 0, mode: 0o040777 }));
    refused(withFile(REG, { uid: 0, mode: 0o040775 }));
  });

  test("a directory owned by another user gives []", () => refused(withFile(REG, { uid: 1000, mode: 0o040755 })));

  test("a missing directory gives []", () => refused(withFile(REG, undefined)));

  test("the file must be a regular file: directory, FIFO and symlink are refused", () => {
    for (const mode of [0o040755, 0o010644, 0o120777]) refused(withFile({ uid: 0, mode }));
  });

  test("the directory must be a directory", () => {
    refused(withFile(REG, { uid: 0, mode: 0o100755 }));
    refused(withFile(REG, { uid: 0, mode: 0o120777 }));
  });

  test("a stat without a usable uid or mode fails closed", () => {
    refused(withFile({ uid: 0, mode: undefined }));
    refused(withFile({ uid: undefined, mode: 0o100644 }));
    refused(withFile({ uid: 0, mode: 1.5 }));
    refused(withFile({ uid: "0", mode: 0o100644 }));
    refused(withFile(REG, { uid: 0, mode: undefined }));
  });

  test("setgid and sticky bits are not write bits: a trusted file with them is still read", () => {
    expect(run({ text: ok, ...withFile({ uid: 0, mode: 0o102644 }) }).r).toEqual(["/usr/bin/claude-rc"]);
    expect(run({ text: ok, ...withFile({ uid: 0, mode: 0o101644 }) }).r).toEqual(["/usr/bin/claude-rc"]);
  });

  test("a missing file gives [] and no log line", () => {
    const { r, logs } = run({ stats: { [DIR]: DIRST } });
    expect(r).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a read error gives [] and a log line", () => {
    const { r, logs } = run({ text: new Error("EIO") });
    expect(r).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(FILE);
  });

  test("content that is not a string gives [] and a log line", () => {
    for (const text of [null, 42, { a: 1 }]) {
      resetRegistryLog();
      const logs: string[] = [];
      const i = io({});
      i.readFile = () => text as any;
      expect(readRegisteredClients(i, (l) => logs.push(l))).toEqual([]);
      expect(logs.length).toBe(1);
    }
  });

  test("a file longer than 64 KB gives [] and one log line", () => {
    const { r, logs } = run({ text: "client /usr/bin/claude-rc\n" + "# x\n".repeat(20000) });
    expect(r).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(FILE);
  });

  test("it stops after 1000 entries", () => {
    const text = Array.from({ length: 1500 }, (_, i) => `client /opt/${i}/claude-rc`).join("\n");
    expect(text.length).toBeLessThan(64 * 1024);
    expect(run({ text }).r.length).toBe(1000);
  });

  test("a throwing log callback does not escape", () => {
    const boom = () => {
      throw new Error("log failed");
    };
    expect(readRegisteredClients(io(withFile({ uid: 1, mode: 0o100644 })), boom)).toEqual([]);
    expect(readRegisteredClients(io({ text: new Error("EIO") }), boom)).toEqual([]);
  });

  test("comments, blank lines and unknown kinds are ignored", () => {
    const { r } = run({ text: "# note\n\n  \ntool /x\nclient /usr/bin/claude-rc\r\n" });
    expect(r).toEqual(["/usr/bin/claude-rc"]);
  });

  test("invalid paths are ignored", () => {
    const text = [
      "client claude-rc",
      "client bin/claude-rc",
      "client /usr/bin/other",
      "client /a/../b/claude-rc",
      "client /usr/local/bin/",
      "client /usr/bin/claude-rc/",
      "client /usr/bin/CLAUDE-RC",
    ].join("\n");
    expect(run({ text }).r).toEqual([]);
  });

  test("an entry with a control character is ignored", () => {
    const text = "client /usr/bin/x\0y/claude-rc\nclient /usr/b\rin/claude-rc\nclient /usr/b\tin/claude-rc\nclient /ok/claude-rc\n";
    expect(run({ text }).r).toEqual(["/ok/claude-rc"]);
  });

  test("spaces inside the path are kept", () => {
    expect(run({ text: "client   /opt/my dir/claude-rc  \n" }).r).toEqual(["/opt/my dir/claude-rc"]);
  });
});

describe("readRegisteredClients on win32", () => {
  const win = (reg: RegQueryResult) => run({ platform: "win32", reg });
  const okv = (data: string): RegQueryResult => ({ status: "ok", data });

  test("it asks for HKLM\\SOFTWARE\\claude-rc and Client", () => {
    const calls: string[][] = [];
    const i: RegistryIo = { ...io({ platform: "win32" }), regQuery: (k, v) => (calls.push([k, v]), okv("C:\\x\\claude-rc.exe")) };
    expect(readRegisteredClients(i)).toEqual(["C:\\x\\claude-rc.exe"]);
    expect(calls).toEqual([["HKLM\\SOFTWARE\\claude-rc", "Client"]]);
  });

  test("an ok value gives its path", () => {
    expect(win(okv("C:\\Program Files\\claude-rc\\bin\\claude-rc.exe")).r).toEqual(["C:\\Program Files\\claude-rc\\bin\\claude-rc.exe"]);
  });

  test("a missing value gives [] and no log", () => {
    const { r, logs } = win({ status: "missing" });
    expect(r).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("an error gives [] and one log line, once for repeated calls", () => {
    const logs: string[] = [];
    const i = io({ platform: "win32", reg: { status: "error", message: "reg.exe exit 5" } });
    for (let n = 0; n < 3; n++) expect(readRegisteredClients(i, (l) => logs.push(l))).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("reg.exe exit 5");
  });

  test("no regQuery gives []", () => {
    expect(readRegisteredClients({ ...io({ platform: "win32" }), regQuery: undefined })).toEqual([]);
  });

  test("UNC, relative, .. , wrong name and control characters give []", () => {
    for (const v of ["\\\\srv\\share\\claude-rc.exe", "C:\\a\\..\\claude-rc.exe", "claude-rc.exe", "C:\\x\\other.exe", "C:\\x\\claude-rc.exe\u0001", "C:\\x\\a\nb\\claude-rc.exe", "C:claude-rc.exe", "C:\\x\\"]) {
      expect(win(okv(v)).r).toEqual([]);
    }
  });

  test("another letter case of claude-rc.exe is accepted", () => {
    expect(win(okv("C:\\x\\CLAUDE-RC.EXE")).r).toEqual(["C:\\x\\CLAUDE-RC.EXE"]);
  });
});

describe("the registry text and log", () => {
  test("a leading BOM is ignored", () => {
    expect(run({ text: "\uFEFFclient /usr/bin/claude-rc\n" }).r).toEqual(["/usr/bin/claude-rc"]);
  });
  test("the same ignored message is logged once per process", () => {
    const logs: string[] = [];
    const o = { text: ok, ...withFile({ uid: 1, mode: 0o100644 }) };
    for (let i = 0; i < 3; i++) expect(readRegisteredClients(io(o), (l) => logs.push(l))).toEqual([]);
    expect(logs.length).toBe(1);
    resetRegistryLog();
    readRegisteredClients(io(o), (l) => logs.push(l));
    expect(logs.length).toBe(2);
  });
});
