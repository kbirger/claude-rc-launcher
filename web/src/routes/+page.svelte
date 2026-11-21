<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";

  // The session list lives at /sessions; the bare address leads there.
  onMount(() => void goto("/sessions", { replaceState: true }));
</script>
