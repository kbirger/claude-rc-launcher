const KEY = "theme";

/** Picks the palette: `?theme=<name>` is remembered, `?theme=default` clears it. Storage may be blocked. */
export function applyTheme(): void {
  let name: string | null = null;
  try {
    const asked = new URLSearchParams(location.search).get("theme");
    if (asked === "default") localStorage.removeItem(KEY);
    else if (asked) localStorage.setItem(KEY, asked);
    name = asked === "default" ? null : (asked ?? localStorage.getItem(KEY));
  } catch {
    /* storage unavailable: fall back to the system palette */
  }
  if (name === "ayu") document.documentElement.dataset.theme = name;
  else delete document.documentElement.dataset.theme;
}
