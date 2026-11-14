<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import * as Card from "#lib/components/ui/card/index.js";
  import ReleaseNotes from "./ReleaseNotes.svelte";
  import { historyQuery } from "./queries";
  import { historyEntries, historyTitle, linesSummary } from "./updatehistory";

  // `names` maps a host id to the name to show. `limit` shows only the newest entries.
  let { names = {}, limit }: { names?: Record<string, string>; limit?: number } = $props();

  const historyQ = createQuery(historyQuery);
  const entries = $derived(historyEntries(historyQ.data ?? {}, limit));
</script>

{#if historyQ.isError}
  <p class="muted">The history is not available.</p>
{:else if entries.length === 0}
  <p class="muted">{historyQ.isPending ? "Loading..." : "No finished updates yet."}</p>
{:else}
  <ul class="m-0 grid list-none gap-3 p-0">
    {#each entries as { host, item } (host + item.entry.startedAt)}
      <li>
        <Card.Root size="sm" class="gap-2">
          <Card.Header>
            <Card.Title class="text-base font-semibold [overflow-wrap:anywhere]">{names[host] ?? host}</Card.Title>
            <Card.Description class={item.entry.status === "failed" || item.entry.status === "rolled back" ? "text-destructive" : ""}>{historyTitle(item)}</Card.Description>
          </Card.Header>
          <Card.Content>
            {#if item.lines.length}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable region must be reachable by keyboard -->
              <pre tabindex="0" role="log" aria-label={`Output of the update of ${names[host] ?? host} (${linesSummary(item.lines.length)})`} class="m-0 max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 text-xs break-all whitespace-pre-wrap">{item.lines.map((l) => l.line).join("\n")}</pre>
            {:else}
              <p class="m-0 text-xs text-muted-foreground">No output was recorded for this update.</p>
            {/if}
            <ReleaseNotes entry={item.entry} />
          </Card.Content>
        </Card.Root>
      </li>
    {/each}
  </ul>
{/if}
