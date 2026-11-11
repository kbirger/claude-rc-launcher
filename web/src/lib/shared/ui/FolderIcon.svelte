<script lang="ts">
  import Folder from "@tabler/icons-svelte/icons/folder";
  import Git from "@tabler/icons-svelte/icons/brand-git";
  import Github from "@tabler/icons-svelte/icons/brand-github";
  import type { IconKind } from "./foldericon";

  let { kind }: { kind: IconKind } = $props();

  const icons = { folder: Folder, git: Git, github: Github };
  const titles: Record<IconKind, string | undefined> = { folder: undefined, git: "Git repository", github: "GitHub repository" };
  const Icon = $derived(icons[kind]);
</script>

<span class="icon" title={titles[kind]} aria-hidden="true"><Icon size="1em" /></span>

<style>
  .icon { display: inline-flex; flex: none; align-self: center; line-height: 1; }
</style>
