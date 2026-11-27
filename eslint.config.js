// Backend lint (server, cli, scripts). The web project has its own config in web/eslint.config.js,
// because it needs the Svelte plugins.
//
// Server layout rules (server/CLAUDE.md). They apply to server/src only. The tests and cli/ are exempt.
// - server-layout/imports, in scripts/eslint/serverlayout.js. It resolves each relative import, so the rules hold at
//   any folder depth and for import(), require() and type import("...") too:
//   (a) A feature imports another feature only through its index.ts. shared/ and win/ have no index, so
//       their files are imported directly. The composition root (index.ts, index.win.ts, hubmain.ts,
//       nodemain.ts, app.ts) is exempt. roles.ts, serve.ts and win/ follow the rule.
//   (b) shared/ imports nothing outside shared/.
//   (c) Only the api/ folder of the same feature and the composition root import an api/ file.
//   (d) In ssh/, hub/ and api/hub.ts never import node/, and node/ and api/node.ts never import hub/.
// - server-layout/file-names, in the same file:
//   (e) A PascalCase file exports a class of that name. Every other class of the file is an *Error class.
//       A lowercase file holds no class other than *Error classes.
//   (f) No file or folder name holds helper, util, misc or common (sshutils.ts and utils/ fail too).
// - import-x/no-cycle: no import cycle of values in server/src. Type-only imports do not count.
// Tests: server/test/eslint-layout.test.ts (it lints with this file, so it fails if a rule or setting goes).
import honoConfig from "@hono/eslint-config";
import stylistic from "@stylistic/eslint-plugin";
import hono from "eslint-plugin-hono";
import prettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";
import serverLayout, { COMPOSITION_ROOT } from "./scripts/eslint/serverlayout.js";

const importX = honoConfig.find((block) => block.plugins?.["import-x"])?.plugins["import-x"];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".claude/**",
      ".superpowers/**",
      "web/**",
      "server/src/web/embedded.ts",
      "server/src/web/embedded.d.ts",
      // The old path of the generated file (before the server layout move). gen-embed.ts deletes it.
      "server/src/embedded.ts",
      ".local-data/**",
    ],
  },
  ...honoConfig,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly" },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { hono, "@stylistic": stylistic },
    rules: {
      "id-length": "error",
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "block-like" },
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
  {
    files: ["server/src/**/*.ts"],
    plugins: { "server-layout": serverLayout },
    // no-cycle must resolve "./x" to x.ts, or it sees no edge at all. The resolver comes with import-x, which the
    // hono config loads, so it adds no dependency.
    settings: {
      "import-x/extensions": [".ts", ".js"],
      "import-x/resolver-next": [
        importX.createNodeResolver({ extensions: [".ts", ".js", ".json"], extensionAlias: { ".js": [".ts", ".js"] } }),
      ],
    },
    rules: { "server-layout/file-names": "error", "import-x/no-cycle": "error" },
  },
  // The composition root imports what it wires, so the import rules skip it.
  { files: ["server/src/**/*.ts"], ignores: COMPOSITION_ROOT, rules: { "server-layout/imports": "error" } },
  // Explicit exceptions to the layout rules. Each one names the file and the reason.
  //
  // Exception 1, win/ (rule a): win/ is a platform folder with no index.ts. ssh/node/wiring.ts and
  // ssh/node/WindowsGrantPlatform.ts import win/ files directly. win/sshclient.ts imports values from ssh/index.ts,
  // and win/pipe.ts and WinSshControl.ts import types from it. So ssh and win depend on each other. This is safe only while
  // ssh/index.ts exports nothing that loads ssh/node/wiring.ts or a win/ file: that would make a cycle at run time.
  // Never re-export the wiring from ssh/index.ts. OPEN_FOLDERS in scripts/eslint/serverlayout.js holds this exception.
  {
    // Exception 2: PinnedRoot.ts holds PinnedFile next to PinnedRoot (rule e). PinnedRoot.ts exports PinnedFile
    // as a type only, so that only PinnedRoot.touchedFile builds one after its checks. A test proves that.
    // A file of its own must export the class as a value, and then any file can build one. That is a design change.
    files: ["server/src/sessions/PinnedRoot.ts"],
    rules: { "server-layout/file-names": "off" },
  },
  {
    // Exception 3:
    // GrantPlatform.ts holds the GrantPlatform interface, the platform seam of the grant code. The Linux and
    // Windows classes implement it in their own files. It has no class, so rule (e) fails. A rename to a
    // lowercase name or a rule for interface files is an owner decision. The file also breaks the rule of
    // server/CLAUDE.md that a file with no class has a lowercase name.
    files: ["server/src/ssh/node/GrantPlatform.ts"],
    rules: { "server-layout/file-names": "off" },
  },
  // The config files are plain JavaScript, outside any tsconfig, so they get no type-aware rules.
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
