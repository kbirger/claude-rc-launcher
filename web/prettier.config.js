// Matches the style the code already has; the backend has its own copy in the repo root.
export default {
  plugins: ["prettier-plugin-svelte"],
  overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
  printWidth: 120,
  singleQuote: false,
  trailingComma: "all",
};
