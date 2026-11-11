import type { Environment } from "vitest/environments";

// A plain Node environment whose modules go through Vite's client pipeline. The Svelte plugin then compiles
// .svelte.ts files for the client, where $effect runs. (In the "node" environment it compiles for the server.)
export default <Environment>{
  name: "node-client",
  viteEnvironment: "client",
  setup() {
    return { teardown() {} };
  },
};
