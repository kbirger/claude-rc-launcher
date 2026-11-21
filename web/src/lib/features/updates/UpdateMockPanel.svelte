<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { MOCK_NAMES, type MockName } from "./mock";

  // TEMPORARY (see mock.ts): pick a canned state, or go back to the live data.
  let { value, onpick }: { value: MockName | null; onpick: (name: MockName | null) => void } = $props();
</script>

<div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-warning p-2 text-xs">
  <span class="text-muted-foreground">Mock (temporary):</span>
  {#each MOCK_NAMES as mock (mock.name)}
    <Button size="sm" variant={value === mock.name ? "default" : "outline"} onclick={() => onpick(mock.name)}>
      {mock.label}
    </Button>
  {/each}
  <Button size="sm" variant={value === null ? "default" : "outline"} onclick={() => onpick(null)}>Live data</Button>
</div>
