import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import serverLayout, { COMPOSITION_ROOT } from "../../scripts/eslint/serverlayout.js";

// The layout rules of eslint.config.js. The rule cases lint virtual files with the plugin alone, which is fast and
// needs no type information. The config cases read the real eslint.config.js, and the cycle cases lint real files
// through it, so a test fails when a rule or a setting goes from that file.

const root = join(import.meta.dir, "..", "..");

const rules = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
    {
      files: ["server/src/**/*.ts"],
      plugins: { "server-layout": serverLayout },
      rules: { "server-layout/file-names": "error" },
    },
    { files: ["server/src/**/*.ts"], ignores: COMPOSITION_ROOT, rules: { "server-layout/imports": "error" } },
  ],
});

const real = new ESLint({ cwd: root });

async function problems(file: string, code: string): Promise<string[]> {
  const results = await rules.lintText(code, { filePath: join(root, file) });

  return results.flatMap((result) =>
    result.messages.map((message) => `${message.ruleId ?? "fatal"}: ${message.message}`),
  );
}

const fails = async (file: string, code: string, rule: string, text: string) => {
  const found = await problems(file, code);

  expect(found.some((line) => line.startsWith(`${rule}:`) && line.includes(text))).toBe(true);
};

const passes = async (file: string, code: string) => {
  expect(await problems(file, code)).toEqual([]);
};

const FEATURE = "through its index.ts";
const API = "import an api/ file";
const SHARED = "shared/ never imports";
const HUB = "Hub-only code";
const NODE = "Node-only code";
const imports = "server-layout/imports";
const names = "server-layout/file-names";

describe("rule (a): another feature only through its index.ts", () => {
  test("an internal file of another feature fails, in every import form", async () => {
    await fails("server/src/sessions/x.ts", 'import { A } from "../ssh/hub/SshService";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'import type { A } from "../ssh/hub/SshService";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'export { A } from "../auth/user";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'export * from "../auth/user";', imports, FEATURE);
    await fails("server/src/ssh/node/x.ts", 'import { A } from "../../sessions/Session";', imports, FEATURE);
    await fails("server/src/hosts/api/x.ts", 'import { A } from "../../sessions/api/all";', imports, FEATURE);
    await fails("server/src/win/x.ts", 'import { A } from "../ssh/node/wiring";', imports, FEATURE);
    await fails("server/src/roles.ts", 'import type { A } from "./auth/user";', imports, FEATURE);
  });

  test("dynamic import(), require(), import = require() and type import() fail", async () => {
    await fails("server/src/sessions/x.ts", 'export const a = import("../ssh/hub/SshService");', imports, FEATURE);
    await fails("server/src/sessions/x.ts", "export const a = import(`../ssh/hub/SshService`);", imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'export const a = require("../auth/user");', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'import a = require("../auth/user");\nexport { a };', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'export type A = import("../auth/user").User;', imports, FEATURE);
  });

  test("paths that are not in normal form fail", async () => {
    await fails("server/src/sessions/x.ts", 'import { A } from "./../ssh/hub/SshService";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'import { A } from "../../src/ssh/hub/SshService";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'import { A } from "../ssh/hub/SshService.ts";', imports, FEATURE);
  });

  test("files at depth 3 and 4 are checked", async () => {
    await fails(
      "server/src/ssh/hub/stores/X.ts",
      'import { A } from "../../../sessions/SessionCatalog";',
      imports,
      FEATURE,
    );
    await fails("server/src/ssh/hub/stores/deep/X.ts", 'import { A } from "../../../../auth/user";', imports, FEATURE);
  });

  test("an index, shared/, win/, roles.ts and the own feature pass", async () => {
    await passes(
      "server/src/sessions/x.ts",
      [
        'import { A } from "../ssh";',
        'import { B } from "../ssh/index";',
        'import { C } from "../shared/HttpError";',
        'import { D } from "../win/pipe";',
        'import { E } from "../roles";',
        'import { F } from "./Session";',
        'import { G } from "node:fs";',
      ].join("\n"),
    );
    await passes("server/src/ssh/node/x.ts", 'import { A } from "../../auth";\nimport { B } from "../TargetStore";');
    await passes(
      "server/src/ssh/hub/stores/x.ts",
      'import { A } from "../../../auth";\nimport { B } from "../GrantStore";',
    );
    await passes("server/src/roles.ts", 'import type { A } from "./auth";');
  });

  test("the composition root is exempt", async () => {
    await passes("server/src/app.ts", 'import { A } from "./auth/api/cli";\nimport { B } from "./ssh/hub/SshService";');
    await passes("server/src/hubmain.ts", 'import { A } from "./ssh/api/local";');
  });
});

describe("rule (b): shared/ imports nothing outside shared/", () => {
  test("a feature or a top file fails, at any depth", async () => {
    await fails("server/src/shared/x.ts", 'import { A } from "../ssh";', imports, SHARED);
    await fails("server/src/shared/x.ts", 'import type { A } from "../roles";', imports, SHARED);
    await fails("server/src/shared/x.ts", 'import { A } from "./../hosts";', imports, SHARED);
    await fails("server/src/shared/text/wrap.ts", 'import { A } from "../../hosts";', imports, SHARED);
  });

  test("a file of shared/ passes", async () => {
    await passes("server/src/shared/x.ts", 'import { A } from "./HttpError";');
    await passes("server/src/shared/text/wrap.ts", 'import { A } from "../HttpError";');
  });
});

describe("rule (c): only the own api/ folder imports an api/ file", () => {
  test("a service or an index fails", async () => {
    await fails("server/src/sessions/x.ts", 'import { A } from "./api/all";', imports, API);
    await fails("server/src/sessions/index.ts", 'export { A } from "./api/all";', imports, API);
    await fails("server/src/ssh/node/x.ts", 'import { A } from "../api/node";', imports, API);
    await fails("server/src/ssh/hub/x.ts", 'import { A } from "../api/hub";', imports, API);
    await fails("server/src/ssh/hub/stores/X.ts", 'import { A } from "../../api/hub";', imports, API);
  });

  test("a file of the same api/ folder passes", async () => {
    await passes("server/src/sessions/api/a.ts", 'import { A } from "./b";\nimport { B } from "../SessionCatalog";');
  });
});

describe("rule (d): hub and node code stay apart in ssh/", () => {
  test("hub to node and node to hub fail", async () => {
    await fails("server/src/ssh/hub/x.ts", 'import { A } from "../node/wiring";', imports, HUB);
    await fails("server/src/ssh/hub/x.ts", 'import { A } from ".././node/wiring";', imports, HUB);
    await fails("server/src/ssh/api/hub.ts", 'import type { A } from "../node/types";', imports, HUB);
    await fails("server/src/ssh/node/x.ts", 'import { A } from "../hub/GrantStore";', imports, NODE);
    await fails("server/src/ssh/api/node.ts", 'import { A } from "../hub/GrantStore";', imports, NODE);
  });

  test("files at depth 3 are checked", async () => {
    await fails("server/src/ssh/hub/stores/X.ts", 'import { A } from "../../node/wiring";', imports, HUB);
    await fails("server/src/ssh/node/deep/x.ts", 'import { A } from "../../hub/GrantStore";', imports, NODE);
  });

  test("the ssh root and the own part pass", async () => {
    await passes("server/src/ssh/hub/x.ts", 'import { A } from "../TargetStore";\nimport { B } from "./GrantStore";');
  });
});

describe("rule (e): class files have the PascalCase name of their class", () => {
  test("a PascalCase file without its class fails", async () => {
    await fails("server/src/ssh/Foo.ts", "export interface Foo { a: number }", names, "must export the class Foo");
    await fails("server/src/ssh/Foo.ts", "export class Bar {}", names, "must export the class Foo");
  });

  test("a second class fails, an error class passes", async () => {
    await fails("server/src/ssh/Foo.ts", "export class Foo {}\nclass Bar {}", names, "second class, Bar");
    await passes("server/src/ssh/Foo.ts", "export class Foo {}\nexport class FooError extends Error {}");
  });

  test("a lowercase file with a class fails, with only an error class it passes", async () => {
    await fails("server/src/ssh/foo.ts", "export class Foo {}", names, "Name the file Foo.ts");
    await fails("server/src/ssh/foo.ts", "class Cursor {}\nexport const a = 1;", names, "Name the file Cursor.ts");
    await passes("server/src/ssh/foo.ts", "export class FooError extends Error {}\nexport const a = 1;");
    await passes("server/src/ssh/foo.ts", "export class Refused extends HttpError {}");
  });
});

describe("rule (f): no generic file or folder names", () => {
  test("helper, util, misc and common fail, with any prefix or suffix", async () => {
    const files = ["helpers", "helper", "utils", "util", "sshutils", "misc-stuff", "common", "Utils", "commonText"];

    for (const name of files) {
      await fails(`server/src/ssh/${name}.ts`, "export const a = 1;", names, `Do not name a file or folder ${name}`);
    }
  });

  test("a folder with such a name fails", async () => {
    await fails("server/src/ssh/utils/keys.ts", "export const a = 1;", names, "Do not name a file or folder utils");
  });

  test("other names, index.ts and declaration files pass", async () => {
    await passes("server/src/ssh/index.ts", 'export { a } from "./grammar";');
    await passes("server/src/ssh/utils.d.ts", "export declare const a: number;");
  });
});

describe("the real eslint.config.js", () => {
  const level = async (file: string, rule: string) => {
    const config = (await real.calculateConfigForFile(join(root, file))) as { rules?: Record<string, unknown[]> };

    return config.rules?.[rule]?.[0];
  };

  test("turns the layout rules and no-cycle on at every depth of server/src", async () => {
    for (const file of [
      "server/src/roles.ts",
      "server/src/ssh/hub/SshService.ts",
      "server/src/ssh/hub/stores/deep/X.ts",
    ]) {
      expect(await level(file, imports)).toBe(2);
      expect(await level(file, names)).toBe(2);
      expect(await level(file, "import-x/no-cycle")).toBe(2);
    }
  });

  test("skips the import rules for the composition root only", async () => {
    expect(await level("server/src/app.ts", imports)).toBeUndefined();
    expect(await level("server/src/app.ts", "import-x/no-cycle")).toBe(2);
  });

  test("turns file-names off only for the two listed exceptions", async () => {
    expect(await level("server/src/sessions/PinnedRoot.ts", names)).toBe(0);
    expect(await level("server/src/ssh/node/GrantPlatform.ts", names)).toBe(0);
    expect(await level("server/src/sessions/PinnedRoot.ts", imports)).toBe(2);
  });
});

describe("import-x/no-cycle with the real eslint.config.js", () => {
  // Real files, because no-cycle reads the files that a file imports. The folders exist only during these tests.
  const tag = `zzcycle${String(process.pid)}`;
  const one = `server/src/${tag}one`;
  const two = `server/src/${tag}two`;

  const write = (file: string, code: string) => {
    writeFileSync(join(root, file), code);
  };

  // A run that was killed leaves its folders behind. Remove those of processes that no longer run.
  const running = (pid: number) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  beforeAll(() => {
    for (const name of readdirSync(join(root, "server/src"))) {
      const pid = /^zzcycle(\d+)(one|two)$/.exec(name)?.[1];

      if (pid !== undefined && !running(Number(pid)))
        rmSync(join(root, "server/src", name), { recursive: true, force: true });
    }

    for (const folder of [one, two]) mkdirSync(join(root, folder), { recursive: true });
    write(`${one}/plainA.ts`, 'import { bb } from "./plainB";\n\nexport const aa = (): number => bb() + 1;\n');
    write(`${one}/plainB.ts`, 'import { aa } from "./plainA";\n\nexport const bb = (): number => aa() - 1;\n');
    write(`${one}/extA.ts`, 'import { dd } from "./extB";\n\nexport const cc = (): number => dd() + 1;\n');
    write(`${one}/extB.ts`, 'import { cc } from "./extA.js";\n\nexport const dd = (): number => cc() - 1;\n');
    write(`${one}/typeA.ts`, 'import type { Tb } from "./typeB";\n\nexport interface Ta {\n  tb?: Tb;\n}\n');
    write(`${one}/typeB.ts`, 'import type { Ta } from "./typeA";\n\nexport interface Tb {\n  ta?: Ta;\n}\n');
    write(`${one}/index.ts`, 'export { ee } from "./barrel";\n');
    write(`${one}/barrel.ts`, `import { ff } from "../${tag}two";\n\nexport const ee = (): number => ff() + 1;\n`);
    write(`${two}/index.ts`, 'export { ff } from "./barrel";\n');
    write(`${two}/barrel.ts`, `import { ee } from "../${tag}one";\n\nexport const ff = (): number => ee() - 1;\n`);
  });

  afterAll(() => {
    for (const folder of [one, two]) rmSync(join(root, folder), { recursive: true, force: true });
  });

  const cycles = async (file: string) => {
    const results = await real.lintFiles([join(root, file)]);

    return results.flatMap((result) => result.messages).filter((message) => message.ruleId === "import-x/no-cycle")
      .length;
  };

  test("a value cycle fails", async () => {
    expect(await cycles(`${one}/plainA.ts`)).toBe(1);
  });

  test("a cycle with a .js specifier for a .ts file fails", async () => {
    expect(await cycles(`${one}/extA.ts`)).toBe(1);
    expect(await cycles(`${one}/extB.ts`)).toBe(1);
  });

  test("a cycle through the index.ts of two features fails", async () => {
    expect(await cycles(`${one}/barrel.ts`)).toBe(1);
  });

  test("a type-only cycle passes", async () => {
    expect(await cycles(`${one}/typeA.ts`)).toBe(0);
  });
});
