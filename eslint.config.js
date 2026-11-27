// Backend lint (server, cli, scripts). The web project has its own config in web/eslint.config.js,
// because it needs the Svelte plugins.
import honoConfig from "@hono/eslint-config";
import stylistic from "@stylistic/eslint-plugin";
import hono from "eslint-plugin-hono";
import prettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".claude/**",
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
  // The config files are plain JavaScript, outside any tsconfig, so they get no type-aware rules.
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
