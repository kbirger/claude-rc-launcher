import { win32 } from "node:path";

/**
 * The version of the service definition that this release expects: the WinSW XML and the launcher script (and the
 * WinSW program) that `install.ps1` writes once. The binary update never rewrites them. Raise this number in a
 * release that needs a changed definition. The test in `win-definition.test.ts` fails when the files change and
 * the number does not.
 */
export const REQUIRED_DEFINITION = 1;

/** A definition that has no marker was written before the marker existed. It counts as version 1. */
const BASELINE = 1;
const MARKER = /<!--\s*claude-rc-service-definition:\s*(\d{1,4})\s*-->/;
const SERVICE_XML = "claude-rc-launcher-svc.xml";

export type DefinitionStatus = { installed: number; required: number };

export function parseInstalledDefinition(xml: string): number {
  const m = MARKER.exec(xml);
  return m ? Number(m[1]) : BASELINE;
}

/** The installed and the required version, read from the XML next to the agent. Undefined when the file cannot be read. */
export function definitionStatus(o: { exePath: string; readFile(path: string): string; required?: number }): DefinitionStatus | undefined {
  try {
    const xml = o.readFile(win32.join(win32.dirname(o.exePath), SERVICE_XML));
    return { installed: parseInstalledDefinition(xml), required: o.required ?? REQUIRED_DEFINITION };
  } catch {
    return undefined;
  }
}
