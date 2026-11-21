// Frontend lint (the SvelteKit app). The backend has its own config in the repo root, because it needs the Hono and
// Bun rules and this one needs the Svelte plugins.
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import prettier from "eslint-plugin-prettier/recommended";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".svelte-kit/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "@stylistic": stylistic },
    rules: {
      "id-length": "error",
      // A name that starts with an underscore marks a value that is on purpose not used (the backend config does the same).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "block-like" },
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
  {
    files: ["**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      // Type information lets svelte/no-navigation-without-resolve accept values that the type system knows came from resolve().
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".svelte"],
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
  ...svelte.configs.prettier,
);
