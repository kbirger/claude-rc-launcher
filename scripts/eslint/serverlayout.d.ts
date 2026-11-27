// Types for serverlayout.js, which is plain JavaScript so that eslint.config.js can load it under Node.
import type { ESLint } from "eslint";

export const COMPOSITION_ROOT: string[];
export function importProblems(fileSegments: string[], specifier: string): string[];
declare const plugin: ESLint.Plugin;
export default plugin;
