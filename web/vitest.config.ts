import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tests compile .svelte.ts models with the same Svelte plugin as the build. The custom environment makes that a client
// compile, and the "browser" condition loads Svelte's client build, so effects run.
export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ["browser"] },
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "./test/client-env.ts" },
});
