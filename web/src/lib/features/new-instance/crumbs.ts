// Breadcrumb segments of a folder path, each with the cumulative path to navigate to.
// A path with a backslash and no slash is a Windows path and splits on the backslash.
export function breadcrumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  const lead = path.startsWith(sep) ? sep : "";
  return parts.map((label, idx) => ({ label, path: lead + parts.slice(0, idx + 1).join(sep) }));
}
