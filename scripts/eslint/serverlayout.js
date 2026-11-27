// Lint rules for the server layout in server/CLAUDE.md. eslint.config.js turns them on for server/src.
//
// - "imports" checks the import rules (a) to (d). It resolves each relative import against the folder of the file,
//   so the rules hold at any depth and for any spelling of the path ("./../x", "../../src/x").
//   It reads import and export declarations, import(), require(), import x = require() and type import("...").
// - "file-names" checks the names of the files: rules (e) and (f).

import { posix } from "node:path";

const SRC = "server/src";

// The files of the composition root. The import rules do not apply to them.
export const COMPOSITION_ROOT = ["index", "index.win", "hubmain", "nodemain", "app"].map((name) => `${SRC}/${name}.ts`);

// Folders that have no index.ts. A feature imports their files directly.
const OPEN_FOLDERS = new Set(["shared", "win"]);

// The path of a file below server/src as segments, or null for a file outside server/src.
function srcSegments(filename) {
  const path = posix.normalize(filename.replaceAll("\\", "/"));
  const at = path.lastIndexOf(`/${SRC}/`);
  const rest =
    at >= 0 ? path.slice(at + SRC.length + 2) : path.startsWith(`${SRC}/`) ? path.slice(SRC.length + 1) : null;

  return rest === null ? null : rest.split("/");
}

// The import target below server/src, without its extension and without a trailing /index.
function targetSegments(fileSegments, specifier) {
  const target = posix.normalize(posix.join(SRC, ...fileSegments.slice(0, -1), specifier));

  if (!target.startsWith(`${SRC}/`)) return null;
  const parts = target
    .slice(SRC.length + 1)
    .replace(/\.(ts|js|mjs|cjs)$/, "")
    .split("/");

  if (parts.length > 1 && parts.at(-1) === "index") parts.pop();

  return parts;
}

// The part of ssh/ a path belongs to: hub/ and api/hub.ts are the hub, node/ and api/node.ts are the node.
function sshPart(segments) {
  if (segments[0] !== "ssh") return null;
  if (segments[1] === "hub" || segments[1] === "node") return segments[1];
  const route = segments[1] === "api" ? segments[2]?.replace(/\.ts$/, "") : undefined;

  if (route === "hub" || route === "node") return route;

  return null;
}

// The broken rules for one import, as message ids.
export function importProblems(fileSegments, specifier) {
  if (!specifier.startsWith(".")) return [];
  const target = targetSegments(fileSegments, specifier);

  if (!target) return [];
  const own = fileSegments.length > 1 ? fileSegments[0] : null;
  const folder = target[0];
  const problems = [];

  if (target.length > 1 && folder !== own && !OPEN_FOLDERS.has(folder)) problems.push("feature");
  if (own === "shared" && folder !== "shared") problems.push("shared");
  if (target[1] === "api" && !(own === folder && fileSegments[1] === "api")) problems.push("api");
  const from = sshPart(fileSegments);
  const to = sshPart(target);

  if (from && to && from !== to) problems.push(from === "hub" ? "hubToNode" : "nodeToHub");

  return problems;
}

// The string of a literal or of a template without expressions, else null.
function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;

  return null;
}

const imports = {
  meta: {
    type: "problem",
    docs: {
      description: "Import rules of server/CLAUDE.md: features, shared/, api/ and the hub and node parts of ssh/.",
    },
    schema: [],
    messages: {
      feature: "Import another feature only through its index.ts (server/CLAUDE.md, Imports).",
      shared: "shared/ never imports a feature or another file outside shared/ (server/CLAUDE.md, Imports).",
      api: "Only the api/ folder of the same feature and the composition root import an api/ file (server/CLAUDE.md, Imports).",
      hubToNode: "Hub-only code never imports node-only code (server/CLAUDE.md, Imports).",
      nodeToHub: "Node-only code never imports hub-only code (server/CLAUDE.md, Imports).",
    },
  },
  create(context) {
    const fileSegments = srcSegments(context.filename);

    if (!fileSegments) return {};
    const check = (node, source) => {
      const specifier = staticString(source);

      if (specifier === null) return;
      for (const messageId of importProblems(fileSegments, specifier)) context.report({ node, messageId });
    };

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) => check(node, node.source ?? node.argument?.literal),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") check(node, node.arguments[0]);
      },
    };
  },
};

// A generic word anywhere in a folder or file name: helpers.ts, sshutils.ts, misc-stuff.ts or a utils/ folder.
const BANNED = /helper|util|misc|common/i;

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
      banned: "Do not name a file or folder {{name}}. Name it for what it does (server/CLAUDE.md, File names).",
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
    const segments = srcSegments(context.filename) ?? [file];

    return {
      Program(program) {
        const banned = segments.map((part) => part.replace(/\.ts$/, "")).find((part) => BANNED.test(part));

        if (banned !== undefined) {
          context.report({ node: program, messageId: "banned", data: { name: banned } });

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

export default { meta: { name: "server-layout" }, rules: { imports, "file-names": fileNames } };
