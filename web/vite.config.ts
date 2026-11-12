import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { kitConfig } from "./kit.config.ts";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(kitConfig)],
  // The format worker splits its grammar chunks, which needs ES modules (the default, iife, cannot split code).
  worker: { format: "es" },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
});
