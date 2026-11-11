<script lang="ts">
  import ArrowUp from "@tabler/icons-svelte/icons/arrow-up";
  import Github from "@tabler/icons-svelte/icons/brand-github";
  import FolderPlus from "@tabler/icons-svelte/icons/folder-plus";

  export type ActionIconName = "up" | "new-folder" | "github";

  let { name }: { name: ActionIconName } = $props();

  const icons = { up: ArrowUp, "new-folder": FolderPlus, github: Github };
  const Icon = $derived(icons[name]);
</script>

<Icon size="1.25em" stroke={1.5} aria-hidden="true" />
