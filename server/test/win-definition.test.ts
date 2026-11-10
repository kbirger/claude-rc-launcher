import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { definitionStatus, parseInstalledDefinition, REQUIRED_DEFINITION } from "../src/win/definition";

const DEPLOY = resolve(import.meta.dir, "../../deploy/windows");
const text = (f: string) => readFileSync(resolve(DEPLOY, f), "utf8").replaceAll("\r\n", "\n");

// The hash of the files that make up the service definition. When it no longer matches, a file of the definition
// changed. If an installation that exists must get the change, raise REQUIRED_DEFINITION in src/win/definition.ts
// and the marker in claude-rc-launcher.xml. In both cases, put the new hash here.
// (The launcher change that replaced Start-Process by System.Diagnostics.Process fixed a rare lost exit code and did not
// raise the version: an installation that has the old script works, except for an agent that ends within milliseconds.)
const DEFINITION_FILES_SHA256 = "be640ab5a4118e80f6166f0e9862d93ed99032d1157055ae34826c60eb9385be";

describe("service definition version", () => {
  test("the marker in the XML template is the version that this release requires", () => {
    expect(parseInstalledDefinition(text("claude-rc-launcher.xml"))).toBe(REQUIRED_DEFINITION);
  });

  test("the XML and the launcher script did not change without a decision about the version", () => {
    const hash = createHash("sha256").update(text("claude-rc-launcher.xml")).update("\n--\n").update(text("claude-rc-launcher-run.ps1")).digest("hex");
    expect(hash).toBe(DEFINITION_FILES_SHA256);
  });

  test("a definition without a marker counts as version 1", () => {
    expect(parseInstalledDefinition("<service></service>")).toBe(1);
    expect(parseInstalledDefinition("<!-- claude-rc-service-definition: 3 -->")).toBe(3);
    expect(parseInstalledDefinition("<!-- claude-rc-service-definition: 99999 -->")).toBe(1);
  });

  test("the status reads the XML next to the agent and reports installed and required", () => {
    const seen: string[] = [];
    const s = definitionStatus({
      exePath: "C:\\Program Files\\claude-rc\\service\\claude-rc-launcher.exe",
      readFile: (p) => (seen.push(p), "<!-- claude-rc-service-definition: 1 -->"),
      required: 2,
    });
    expect(s).toEqual({ installed: 1, required: 2 });
    expect(seen).toEqual(["C:\\Program Files\\claude-rc\\service\\claude-rc-launcher-svc.xml"]);
  });

  test("an unreadable XML gives no status", () => {
    expect(definitionStatus({ exePath: "C:\\x\\a.exe", readFile: () => { throw new Error("nope"); } })).toBeUndefined();
  });
});
