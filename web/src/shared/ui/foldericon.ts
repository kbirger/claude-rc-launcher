import type { DirListing } from "../api";

export type IconKind = "folder" | "git" | "github";

/** A missing kind (an older node, or a regular folder) shows the plain folder icon. */
export function iconKind(entry: DirListing["dirs"][number]): IconKind {
  return entry.kind === "git" || entry.kind === "github" ? entry.kind : "folder";
}
