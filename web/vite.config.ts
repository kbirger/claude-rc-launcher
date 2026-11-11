import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { kitConfig } from "./kit.config.ts";

export default defineConfig({
  plugins: [sveltekit(kitConfig)],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
});
