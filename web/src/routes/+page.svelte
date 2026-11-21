<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";

  // The session list lives at /sessions; the bare address leads there.
  onMount(() => void goto(resolve("/sessions"), { replaceState: true }));
</script>
