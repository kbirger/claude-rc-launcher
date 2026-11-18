<script lang="ts">
  import ArrowUp from "@tabler/icons-svelte/icons/arrow-big-up-filled";
  import Github from "@tabler/icons-svelte/icons/brand-github-filled";
  import FolderPlus from "@tabler/icons-svelte/icons/folder-plus";
  import Refresh from "@tabler/icons-svelte/icons/refresh";

  export type ActionIconName = "up" | "new-folder" | "github" | "refresh";

  let { name }: { name: ActionIconName } = $props();

  const icons = { up: ArrowUp, "new-folder": FolderPlus, github: Github, refresh: Refresh };
  const Icon = $derived(icons[name]);
</script>

<Icon size="1.25em" stroke={1.5} aria-hidden="true" />
