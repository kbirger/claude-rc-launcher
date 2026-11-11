import adapter from "@sveltejs/adapter-static";

// SvelteKit options, shared by the build (vite.config.ts) and the tests (vitest.config.ts).
// Single-page app: every URL falls back to index.html. The output folder is the one scripts/gen-embed.ts embeds.
export const kitConfig = {
  adapter: adapter({ pages: "dist", assets: "dist", fallback: "index.html", strict: true }),
  // Absolute asset URLs, because the fallback page is served for any path.
  paths: { relative: false },
};
