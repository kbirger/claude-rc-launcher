<script lang="ts">
  import { useIsFetching } from "@tanstack/svelte-query";

  const SHOW_AFTER_MS = 300;
  const SHOW_AT_LEAST_MS = 600;

  // Counts only queries that already hold data: a refetch of what is on screen, whether a poll, a refocus or a pull.
  // A first load has its own "Loading" line. The stale data stays visible while the bar runs.
  const fetching = useIsFetching({ predicate: (q) => q.state.data !== undefined });
  let visible = $state(false);

  // A fetch that ends within SHOW_AFTER_MS never shows the bar, so the 15 second polls do not flicker.
  // Once shown, the bar stays for SHOW_AT_LEAST_MS so a short fetch does not flash.
  $effect(() => {
    if (fetching.current > 0) {
      const t = setTimeout(() => (visible = true), SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    if (visible) {
      const t = setTimeout(() => (visible = false), SHOW_AT_LEAST_MS - SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
  });
</script>

{#if visible}
  <div class="bar" role="progressbar" aria-label="Refreshing data"></div>
{/if}

<style>
  /* Sits on the bottom edge of the sticky header. */
  .bar { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; pointer-events: none; }
  .bar::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 35%; background: var(--primary); animation: refresh-bar 1.1s ease-in-out infinite; }
  @keyframes refresh-bar { from { left: -35%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .bar::before { width: 100%; animation: none; opacity: 0.6; } }
</style>
