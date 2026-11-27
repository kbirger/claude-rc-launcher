import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { join } from "node:path";
import serverLayout, { serverImportBlocks } from "../../scripts/eslint/serverlayout.js";

// The layout rules of eslint.config.js on files that do not exist. The config blocks are the real ones, so a
// test also proves that a later block does not drop the patterns of an earlier one.

const root = join(import.meta.dir, "..", "..");

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
    ...serverImportBlocks(),
    {
      files: ["server/src/**/*.ts"],
      plugins: { "server-layout": serverLayout },
      rules: { "server-layout/file-names": "error" },
    },
  ],
});

async function problems(file: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: join(root, file) });

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
const imports = "no-restricted-imports";
const names = "server-layout/file-names";

describe("rule (a): another feature only through its index.ts", () => {
  test("an internal file of another feature fails, in every import form", async () => {
    await fails("server/src/sessions/x.ts", 'import { A } from "../ssh/hub/SshService";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'import type { A } from "../ssh/hub/SshService";', imports, FEATURE);
    await fails("server/src/sessions/x.ts", 'export { A } from "../auth/user";', imports, FEATURE);
    await fails("server/src/ssh/node/x.ts", 'import { A } from "../../sessions/Session";', imports, FEATURE);
    await fails("server/src/hosts/api/x.ts", 'import { A } from "../../sessions/api/all";', imports, FEATURE);
    await fails("server/src/win/x.ts", 'import { A } from "../ssh/node/wiring";', imports, FEATURE);
    await fails("server/src/roles.ts", 'import type { A } from "./auth/user";', imports, FEATURE);
  });

  test("an index, shared/, win/, roles.ts and the own feature pass", async () => {
    await passes(
      "server/src/sessions/x.ts",
      [
        'import { A } from "../ssh";',
        'import { B } from "../shared/HttpError";',
        'import { C } from "../win/pipe";',
        'import { D } from "../roles";',
        'import { E } from "./Session";',
      ].join("\n"),
    );
    await passes("server/src/ssh/node/x.ts", 'import { A } from "../../auth";\nimport { B } from "../TargetStore";');
    await passes("server/src/roles.ts", 'import type { A } from "./auth";');
  });

  test("the composition root is exempt", async () => {
    await passes("server/src/app.ts", 'import { A } from "./auth/api/cli";\nimport { B } from "./ssh/hub/SshService";');
    await passes("server/src/hubmain.ts", 'import { A } from "./ssh/api/local";');
  });
});

describe("rule (b): shared/ imports no feature", () => {
  test("a feature or a top file fails", async () => {
    await fails("server/src/shared/x.ts", 'import { A } from "../ssh";', imports, SHARED);
    await fails("server/src/shared/x.ts", 'import type { A } from "../roles";', imports, SHARED);
  });

  test("a file of shared/ passes", async () => {
    await passes("server/src/shared/x.ts", 'import { A } from "./HttpError";');
  });
});

describe("rule (c): only the own api/ folder imports an api/ file", () => {
  test("a service or an index fails", async () => {
    await fails("server/src/sessions/x.ts", 'import { A } from "./api/all";', imports, API);
    await fails("server/src/sessions/index.ts", 'export { A } from "./api/all";', imports, API);
    await fails("server/src/ssh/node/x.ts", 'import { A } from "../api/node";', imports, API);
    await fails("server/src/ssh/hub/x.ts", 'import { A } from "../api/hub";', imports, API);
  });

  test("a file of the same api/ folder passes", async () => {
    await passes("server/src/sessions/api/a.ts", 'import { A } from "./b";\nimport { B } from "../SessionCatalog";');
  });
});

describe("rule (d): hub and node code stay apart in ssh/", () => {
  test("hub to node and node to hub fail", async () => {
    await fails("server/src/ssh/hub/x.ts", 'import { A } from "../node/wiring";', imports, HUB);
    await fails("server/src/ssh/api/hub.ts", 'import type { A } from "../node/types";', imports, HUB);
    await fails("server/src/ssh/node/x.ts", 'import { A } from "../hub/GrantStore";', imports, NODE);
    await fails("server/src/ssh/api/node.ts", 'import { A } from "../hub/GrantStore";', imports, NODE);
  });

  test("the hub and node blocks keep rule (a)", async () => {
    await fails("server/src/ssh/hub/x.ts", 'import { A } from "../../sessions/Session";', imports, FEATURE);
    await fails("server/src/ssh/api/node.ts", 'import { A } from "../../auth/user";', imports, FEATURE);
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

describe("rule (f): no generic file names", () => {
  test("helpers, utils, common and misc fail", async () => {
    for (const name of ["helpers", "utils", "common", "misc", "Utils"]) {
      await fails(`server/src/ssh/${name}.ts`, "export const a = 1;", names, `Do not name a file ${name}`);
    }
  });

  test("other names, index.ts and declaration files pass", async () => {
    await passes("server/src/ssh/index.ts", 'export { a } from "./grammar";');
    await passes("server/src/ssh/utils.d.ts", "export declare const a: number;");
  });
});
