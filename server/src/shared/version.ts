declare const BUILD_VERSION: string | undefined;

// `bun build --define BUILD_VERSION=...` sets this at build time. Running from source gives "dev".
export const VERSION: string = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";
