// The types of server/src/embedded.ts, which scripts/gen-embed.ts generates and git ignores. In a checkout where it does not
// exist yet, this file lets the import in webfiles.ts compile. TypeScript prefers the real embedded.ts when it exists.
import type { WebFiles } from "./static";

export const embeddedFiles: WebFiles;
