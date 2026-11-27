// Lint rules for the server layout in server/CLAUDE.md. The config in eslint.config.js uses both parts.
//
// - serverImportBlocks() builds no-restricted-imports blocks for server/src. A flat config block replaces
//   the options of a rule, it does not add to them, so each block holds every pattern for its files.
// - The plugin rule "file-names" checks the names of the files.

const SRC = "server/src";

// The files of the composition root. The import rules do not apply to them.
export const COMPOSITION_ROOT = ["index", "index.win", "hubmain", "nodemain", "app"].map((name) => `${SRC}/${name}.ts`);

// Folders that have no index.ts. A feature imports their files directly.
const OPEN_FOLDERS = ["shared", "win"];

// An import of a file inside another folder of server/src, from a file `depth` folders below server/src.
// "../ssh" is the index of a feature and passes. "../ssh/hub/SshService" fails.
const featureInternal = (depth) => ({
  regex: `^${depth === 0 ? "\\./" : "(\\.\\./){" + String(depth) + "}"}(?!(${OPEN_FOLDERS.join("|")})/)[^./][^/]*/`,
  message: "Import another feature only through its index.ts (server/CLAUDE.md, Imports).",
});

const apiFile = {
  regex: "^\\.{1,2}/(.*/)?api(/|$)",
  message:
    "Only the api/ folder of the same feature and the composition root import an api/ file (server/CLAUDE.md, Imports).",
};

const sharedOut = {
  regex: "^\\.\\./",
  message: "shared/ never imports a feature or another file outside shared/ (server/CLAUDE.md, Imports).",
};

const hubToNode = {
  regex: "^\\.\\./node(/|$)",
  message: "Hub-only code never imports node-only code (server/CLAUDE.md, Imports).",
};

const nodeToHub = {
  regex: "^\\.\\./hub(/|$)",
  message: "Node-only code never imports hub-only code (server/CLAUDE.md, Imports).",
};

const block = (files, patterns, ignores) => ({
  files,
  ...(ignores ? { ignores } : {}),
  rules: { "no-restricted-imports": ["error", { patterns }] },
});

// The order matters: a later block wins for the files it matches.
export function serverImportBlocks() {
  return [
    block([`${SRC}/*.ts`], [featureInternal(0), apiFile], COMPOSITION_ROOT),
    block([`${SRC}/*/*.ts`], [featureInternal(1), apiFile]),
    block([`${SRC}/*/*/*.ts`], [featureInternal(2), apiFile]),
    block([`${SRC}/*/api/*.ts`], [featureInternal(2)]),
    block([`${SRC}/shared/*.ts`], [sharedOut]),
    block([`${SRC}/ssh/hub/*.ts`], [featureInternal(2), apiFile, hubToNode]),
    block([`${SRC}/ssh/node/*.ts`], [featureInternal(2), apiFile, nodeToHub]),
    block([`${SRC}/ssh/api/hub.ts`], [featureInternal(2), hubToNode]),
    block([`${SRC}/ssh/api/node.ts`], [featureInternal(2), nodeToHub]),
  ];
}

const BANNED = new Set(["helpers", "utils", "common", "misc"]);

// The class extends Error or another *Error class. An error class may sit in a file of another name.
const isErrorClass = (node) => node.superClass?.type === "Identifier" && node.superClass.name.endsWith("Error");

// The top-level class declarations of the file, exported or not.
const topClasses = (program) =>
  program.body.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;

    return declaration?.type === "ClassDeclaration" && declaration.id
      ? [{ node: declaration, exported: declaration !== statement }]
      : [];
  });

const fileNames = {
  meta: {
    type: "problem",
    docs: { description: "File names of server/CLAUDE.md: PascalCase class files, no generic names." },
    schema: [],
    messages: {
      banned: "Do not name a file {{name}}. Name it for what it does (server/CLAUDE.md, File names).",
      noClass: "{{file}} has a PascalCase name, so it must export the class {{name}} (server/CLAUDE.md, File names).",
      notPascal:
        "{{file}} holds the class {{name}}. Name the file {{name}}.ts, after its class (server/CLAUDE.md, File names).",
      secondClass: "{{file}} holds a second class, {{name}}. Give it a file of its own (server/CLAUDE.md, File names).",
    },
  },
  create(context) {
    const file = context.filename.split(/[\\/]/).pop() ?? "";

    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) return {};

    const name = file.split(".")[0] ?? "";

    return {
      Program(program) {
        if (BANNED.has(name.toLowerCase())) {
          context.report({ node: program, messageId: "banned", data: { name } });

          return;
        }

        const classes = topClasses(program);
        const pascal = /^[A-Z]/.test(name);

        if (pascal && !classes.some((cls) => cls.exported && cls.node.id.name === name)) {
          context.report({ node: program, messageId: "noClass", data: { file, name } });
        }

        // Error classes may sit next to the main class or next to functions. Every other class has a file of its own.
        for (const { node } of classes) {
          if (isErrorClass(node) || (pascal && node.id.name === name)) continue;
          const messageId = pascal ? "secondClass" : "notPascal";

          context.report({ node: node.id, messageId, data: { file, name: node.id.name } });
        }
      },
    };
  },
};

export default { meta: { name: "server-layout" }, rules: { "file-names": fileNames } };
