export const THEMES = ["default", "ayu", "tokyonight"] as const;
export type ThemeName = (typeof THEMES)[number];
export const MODES = ["system", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

const THEME_KEY = "theme";
const MODE_KEY = "mode";

export const isTheme = (v: unknown): v is ThemeName => THEMES.includes(v as ThemeName);
export const isMode = (v: unknown): v is Mode => MODES.includes(v as Mode);

/** Ayu and Tokyo Night only exist as dark palettes, so they are dark whatever the mode says. */
export const modeApplies = (theme: ThemeName): boolean => theme === "default";

export function resolveDark(theme: ThemeName, mode: Mode, systemDark: boolean): boolean {
  if (!modeApplies(theme)) return true;
  return mode === "dark" || (mode === "system" && systemDark);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable (private window, blocked): use the defaults
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts until the page closes */
  }
}

/** The saved choice. `?theme=<name>` in the URL still works and is saved; `?theme=default` goes back to the default. */
export function loadChoice(): { theme: ThemeName; mode: Mode } {
  try {
    const asked = new URLSearchParams(location.search).get("theme");
    if (asked === "default") write(THEME_KEY, null);
    else if (isTheme(asked)) write(THEME_KEY, asked);
  } catch {
    /* no location: ignore */
  }
  const theme = read(THEME_KEY);
  const mode = read(MODE_KEY);
  return { theme: isTheme(theme) ? theme : "default", mode: isMode(mode) ? mode : "system" };
}

export function saveTheme(theme: ThemeName) {
  write(THEME_KEY, theme === "default" ? null : theme);
}

export function saveMode(mode: Mode) {
  write(MODE_KEY, mode === "system" ? null : mode);
}

/** Puts the choice on <html>: the `dark` class and the `data-theme` attribute that src/app.css reads. */
export function applyToDocument(theme: ThemeName, mode: Mode, systemDark: boolean) {
  const root = document.documentElement;
  if (theme === "default") delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.classList.toggle("dark", resolveDark(theme, mode, systemDark));
}
