import { applyToDocument, resolveDark, loadChoice, saveMode, saveTheme, type Mode, type ThemeName } from "./theme";

const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;

/** The palette and the light/dark/system choice. `dark` is the result: whether the page is dark now. */
export const appearance = $state<{ theme: ThemeName; mode: Mode; dark: boolean }>({ theme: "default", mode: "system", dark: false });

function apply() {
  appearance.dark = resolveDark(appearance.mode, dark?.matches ?? false);
  applyToDocument(appearance.theme, appearance.mode, dark?.matches ?? false);
}

/** Call once at start-up (the script in app.html already set the classes, this reads the same choice into state). */
export function initAppearance() {
  Object.assign(appearance, loadChoice());
  apply();
  dark?.addEventListener("change", apply);
}

export function setTheme(theme: ThemeName) {
  appearance.theme = theme;
  saveTheme(theme);
  apply();
}

export function setMode(mode: Mode) {
  appearance.mode = mode;
  saveMode(mode);
  apply();
}
