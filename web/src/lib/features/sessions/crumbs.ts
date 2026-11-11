// Breadcrumb for a folder path relative to the session root. The first crumb is the root.
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [{ name: "/", path: "" }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }))];
}
