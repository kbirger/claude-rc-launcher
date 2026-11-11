<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import FolderGit from "@lucide/svelte/icons/folder-git";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import type { IconKind } from "./foldericon";

  let { kind }: { kind: IconKind } = $props();

  // Lucide has no brand marks: a GitHub repository gets the second Git folder variant.
  const icons = { folder: Folder, git: FolderGit, github: FolderGit2 };
  const titles: Record<IconKind, string | undefined> = { folder: undefined, git: "Git repository", github: "GitHub repository" };
  const Icon = $derived(icons[kind]);
</script>

<span class="icon" title={titles[kind]} aria-hidden="true"><Icon size="1em" /></span>

<style>
  .icon { display: inline-flex; flex: none; align-self: center; line-height: 1; }
</style>
