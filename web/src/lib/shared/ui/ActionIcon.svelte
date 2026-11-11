<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import CloudDownload from "@lucide/svelte/icons/cloud-download";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";

  export type ActionIconName = "up" | "new-folder" | "github";

  let { name }: { name: ActionIconName } = $props();

  // Lucide has no brand marks, so the GitHub clone action uses a download glyph; its button text names GitHub.
  const icons = { up: ArrowUp, "new-folder": FolderPlus, github: CloudDownload };
  const Icon = $derived(icons[name]);
</script>

<Icon size="1.25em" strokeWidth={1.5} aria-hidden="true" />
