
export type IconKind = "folder" | "git" | "github";

/** A missing kind (an older node, or a regular folder) shows the plain folder icon. */
export function iconKind(entry: { kind?: "git" | "github" }): IconKind {
  return entry.kind === "git" || entry.kind === "github" ? entry.kind : "folder";
}
