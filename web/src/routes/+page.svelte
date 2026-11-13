<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";

  // The instance list lives at /instances; the bare address leads there.
  onMount(() => void goto("/instances", { replaceState: true }));
</script>
