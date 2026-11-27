// Types for serverlayout.js, which is plain JavaScript so that eslint.config.js can load it under Node.
import type { ESLint, Linter } from "eslint";

export const COMPOSITION_ROOT: string[];
export function serverImportBlocks(): Linter.Config[];
declare const plugin: ESLint.Plugin;
export default plugin;
