<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { historyQuery } from "./queries";
  import { historyTitle, linesSummary } from "./updatehistory";

  let { host }: { host: string } = $props();

  let open = $state(false);
  const historyQ = createQuery(() => ({ ...historyQuery(), enabled: open }));
  const items = $derived(historyQ.data?.[host] ?? []);
</script>

<details class="history" bind:open>
  <summary>Update history</summary>
  {#if historyQ.isError}
    <p class="muted">The history is not available.</p>
  {:else if items.length === 0}
    <p class="muted">{historyQ.isPending ? "Loading..." : "No finished updates yet."}</p>
  {:else}
    <ul>
      {#each items as i (i.entry.startedAt)}
        <li>
          <details>
            <summary>{historyTitle(i)} ({linesSummary(i.lines.length)})</summary>
            {#if i.lines.length}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable region must be reachable by keyboard -->
              <pre tabindex="0" role="log" aria-label={`Output of the update of ${host}`}>{i.lines.map((l) => l.line).join("\n")}</pre>
            {/if}
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</details>

<style>
  .history { padding: 0 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; }
  .muted { color: var(--muted); margin: 0 0 8px; }
  pre { margin: 0 0 8px; max-height: 12rem; overflow: auto; padding: 8px; font-size: 0.8rem; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
</style>
