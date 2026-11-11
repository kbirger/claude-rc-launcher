import type { Environment } from "vitest/environments";
import { environmentManager } from "@tanstack/svelte-query";

// A plain Node environment whose modules go through Vite's client pipeline. The Svelte plugin then compiles
// .svelte.ts files for the client, where $effect runs. (In the "node" environment it compiles for the server.)
export default <Environment>{
  name: "node-client",
  viteEnvironment: "client",
  setup() {
    // TanStack sees no `window` here and treats the run as a server, which turns off refetchInterval. Models poll,
    // so the tests run as a browser would.
    // Keep the value, not the function: `isServer` calls the function that setIsServer replaces.
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    return {
      teardown() {
        environmentManager.setIsServer(() => wasServer);
      },
    };
  },
};
