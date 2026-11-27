import { describe, expect, test } from "bun:test";
import {
  SCRIPT_PATH_RE,
  formatCommand,
  linuxInstallScript,
  linuxScript,
  parseAnswer,
  parseCommand,
  provisionerLine,
} from "../../../src/ssh/provisioner/key";
import vectors from "../../../src/ssh/provisioner/key.vectors.json";

const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGmainmainmainmainmainmainmainmainmainmain";
const PBLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGprovprovprovprovprovprovprovprovprovprov";
const MAIN = `ssh-ed25519 ${BLOB} claude-rc:nas`;
const PROV = `ssh-ed25519 ${PBLOB} claude-rc-provisioner:nas`;

describe("parseCommand", () => {
  test("parseCommand takes every accept vector", () => {
    for (const text of vectors.accept) expect(parseCommand(text), text.slice(0, 40)).toBeDefined();
  });

  test("parseCommand refuses every reject vector", () => {
    for (const text of vectors.reject) expect(parseCommand(text), JSON.stringify(text.slice(0, 40))).toBeUndefined();
  });

  test("parseCommand reads the four words and the list", () => {
    expect(parseCommand("on")).toEqual({ kind: "on" });
    expect(parseCommand("uninstall")).toEqual({ kind: "uninstall" });
    expect(parseCommand("sources 10.0.0.1,host.example")).toEqual({
      kind: "sources",
      list: ["10.0.0.1", "host.example"],
    });
  });

  test("parseCommand refuses wildcards, CIDR ranges and quotes in a list", () => {
    for (const bad of ["*", "192.168.0.0/24", "a?b", "a*", "a b", "a'b", 'a"b', "a,b c", "a,,b"])
      expect(parseCommand(`sources ${bad}`), bad).toBeUndefined();
  });
});

describe("formatCommand", () => {
  test("formatCommand round-trips each accept vector", () => {
    for (const text of vectors.accept) {
      const command = parseCommand(text);
      if (command === undefined) throw new Error(`not parsed: ${text.slice(0, 40)}`);
      expect(formatCommand(command)).toBe(text);
    }
  });

  test("formatCommand throws for an empty list", () => {
    expect(() => formatCommand({ kind: "sources", list: [] })).toThrow();
  });

  test("formatCommand throws for every list that the grammar refuses", () => {
    const lists = [["*"], ["192.168.0.0/24"], ["a?b"], ["a b"], ["a'b"], ["a,b"], [""], ["-a"], ["a".repeat(256)]];
    for (const list of lists) expect(() => formatCommand({ kind: "sources", list }), JSON.stringify(list)).toThrow();
    expect(() =>
      formatCommand({ kind: "sources", list: Array.from({ length: 201 }, (_value, index) => `h${index}`) }),
    ).toThrow();
    expect(() => formatCommand({ kind: "sources", list: Array.from({ length: 20 }, () => "a".repeat(255)) })).toThrow();
  });
});

describe("parseAnswer", () => {
  test("parseAnswer reads each answer form", () => {
    expect(parseAnswer("ok on 10.0.0.1,10.0.0.2\n")).toEqual({ kind: "on", list: ["10.0.0.1", "10.0.0.2"] });
    expect(parseAnswer("ok sources 10.0.0.1\n")).toEqual({ kind: "sources", list: ["10.0.0.1"] });
    expect(parseAnswer("ok off\n")).toEqual({ kind: "off" });
    expect(parseAnswer("ok uninstall\n")).toEqual({ kind: "uninstall" });
    expect(parseAnswer("ok status present 10.0.0.1\n")).toEqual({ kind: "status", present: true, list: ["10.0.0.1"] });
    expect(parseAnswer("ok status absent 10.0.0.1")).toEqual({ kind: "status", present: false, list: ["10.0.0.1"] });
    expect(parseAnswer("ok status absent\n")).toEqual({ kind: "status", present: false, list: [] });
    expect(parseAnswer("ok installed /home/u/.claude-rc/provisioner-nas.sh\n")).toEqual({
      kind: "installed",
      path: "/home/u/.claude-rc/provisioner-nas.sh",
    });
  });

  test("parseAnswer refuses a second word that it does not know", () => {
    for (const text of [
      "ok maybe",
      "ok status maybe 10.0.0.1",
      "ok",
      "",
      "okay on 10.0.0.1",
      "ok on",
      "ok off now",
      "error 2 bad-command x",
    ])
      expect(parseAnswer(text), text).toBeUndefined();
  });

  test("parseAnswer reads the first line only and refuses a bad list or path", () => {
    expect(parseAnswer("ok off\nok uninstall\n")).toEqual({ kind: "off" });
    expect(parseAnswer("garbage\nok off\n")).toBeUndefined();
    expect(parseAnswer("ok on a*\n")).toBeUndefined();
    expect(parseAnswer("ok on 10.0.0.1,\n")).toBeUndefined();
    expect(parseAnswer("ok status present\n")).toBeUndefined();
    expect(parseAnswer("ok installed relative/path\n")).toBeUndefined();
    expect(parseAnswer("ok installed /a b/c\n")).toBeUndefined();
  });
});

describe("provisionerLine", () => {
  const input = { publicLine: PROV, source: "192.168.1.103", scriptPath: "/home/u/.claude-rc/provisioner-nas.sh" };

  test("provisionerLine refuses a script path with a quote, a comma or a space", () => {
    for (const bad of ['/a"b', "/a'b", "/a,b", "/a b", "/a\\b", "rel/path", "/a$b", "/a`b", "/a\nb", ""])
      expect(() => provisionerLine({ ...input, scriptPath: bad }), bad).toThrow();
    expect(SCRIPT_PATH_RE.test(input.scriptPath)).toBe(true);
  });

  test("provisionerLine puts from, restrict and command in front of the key", () => {
    expect(provisionerLine(input)).toBe(
      `from="192.168.1.103",restrict,command="/home/u/.claude-rc/provisioner-nas.sh" ${PROV}`,
    );
  });

  test("provisionerLine refuses a bad source or a key line that is not the provisioner key", () => {
    expect(() => provisionerLine({ ...input, source: "10.0.0.0/24" })).toThrow();
    expect(() => provisionerLine({ ...input, source: "a,b" })).toThrow();
    expect(() => provisionerLine({ ...input, publicLine: MAIN })).toThrow();
    expect(() => provisionerLine({ ...input, publicLine: `${PROV}\nssh-ed25519 AAAA x` })).toThrow();
  });
});

describe("linuxScript", () => {
  const text = linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: PBLOB });

  test("linuxScript holds no eval", () => {
    expect(text).not.toMatch(/\beval\b/);
    expect(text).not.toMatch(/\bsource\b|^\s*\. /m);
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("linuxScript quotes the main line as data", () => {
    expect(text).toContain(`'${MAIN}'`);
    const evil = `ssh-ed25519 ${BLOB} claude-rc:nas`;
    expect(() => linuxScript({ targetId: "nas", mainPublicLine: `${evil}'; id; '`, provisionerBlob: PBLOB })).toThrow();
    expect(() =>
      linuxScript({
        targetId: "nas",
        mainPublicLine: `${evil}\nssh-ed25519 AAAA claude-rc:nas`,
        provisionerBlob: PBLOB,
      }),
    ).toThrow();
    expect(() => linuxScript({ targetId: "other", mainPublicLine: MAIN, provisionerBlob: PBLOB })).toThrow();
    expect(() => linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: "a'b" })).toThrow();
  });

  test("linuxScript has no test hook unless it is asked for", () => {
    expect(text).not.toContain("guard-test");
    expect(linuxScript({ targetId: "nas", mainPublicLine: MAIN, provisionerBlob: PBLOB, guardTest: true })).toContain(
      "guard-test",
    );
  });
});

describe("linuxInstallScript", () => {
  const base = {
    targetId: "nas",
    mainPublicLine: MAIN,
    provisionerPublicLine: PROV,
    localSource: "192.168.1.103",
    sources: ["10.0.0.1"],
  };

  test("linuxInstallScript is an sh script and checks its input", () => {
    expect(linuxInstallScript(base).shell).toBe("sh");
    expect(() => linuxInstallScript({ ...base, sources: [] })).toThrow();
    expect(() => linuxInstallScript({ ...base, sources: ["10.0.0.0/24"] })).toThrow();
    expect(() => linuxInstallScript({ ...base, localSource: "a,b" })).toThrow();
    expect(() => linuxInstallScript({ ...base, provisionerPublicLine: MAIN })).toThrow();
    expect(() => linuxInstallScript({ ...base, targetId: "bad id" })).toThrow();
  });
});
