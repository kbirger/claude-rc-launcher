<script lang="ts">
  import { tick } from "svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { logsQuery } from "./queries";
  import { followsBottom, outputSummary } from "./updateoutput";

  // `open` is only the start state: a running update opens the panel, a finished one leaves it closed.
  let { host, open: startOpen = false }: { host: string; open?: boolean } = $props();

  const logsQ = createQuery(logsQuery);
  const lines = $derived(logsQ.data?.[host] ?? []);
  // svelte-ignore state_referenced_locally
  let open = $state(startOpen);
  let box = $state<HTMLPreElement>();
  let follow = true;

  function onscroll() {
    if (box) follow = followsBottom(box.scrollTop, box.clientHeight, box.scrollHeight);
  }

  // Newest line at the bottom; follow it while the reader has not scrolled up.
  $effect(() => {
    lines.length;
    if (!open || !follow) return;
    void tick().then(() => {
      if (box) box.scrollTop = box.scrollHeight;
    });
  });
</script>

{#if lines.length}
  <details class="output" bind:open>
    <summary>{outputSummary(lines.length)}</summary>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable region must be reachable by keyboard -->
    <pre bind:this={box} {onscroll} tabindex="0" role="log" aria-label={`Output of ${host}`}>{lines.map((l) => l.line).join("\n")}</pre>
  </details>
{/if}

<style>
  .output { flex-basis: 100%; }
  summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; color: var(--muted-foreground); }
  pre { margin: 0; max-height: 12rem; overflow: auto; padding: 8px; font-size: 0.8rem; background: var(--card); border: 1px solid var(--border); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
</style>
