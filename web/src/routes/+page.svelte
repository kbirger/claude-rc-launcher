<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";

  // The instance list lives at /instances; the bare address leads there.
  onMount(() => void goto(resolve("/instances"), { replaceState: true }));
</script>
