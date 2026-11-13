<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { isUnsupported } from "./api";
  import { liveBadges, sessionDetail, sessionMatches, sessionsHref, sessionTitle, worktreeName } from "./format";
  import { sessionsQuery } from "./queries";

  let { host, instance, now }: { host: string; instance: string; now: number } = $props();

  const q = createQuery(() => sessionsQuery(host, instance));
  let filter = $state("");
  const shown = $derived((q.data ?? []).filter((s) => sessionMatches(s, filter)));
</script>

{#if q.isPending}
  <p class="text-muted-foreground">Loading sessions...</p>
{:else if isUnsupported(q.error)}
  <p class="text-muted-foreground">This node does not support session files. Update the node.</p>
{:else if q.error}
  <p class="error">{q.error.message}</p>
{:else if !q.data?.length}
  <p class="text-muted-foreground">No sessions yet for this instance.</p>
{:else}
  <input
    type="search"
    bind:value={filter}
    placeholder="Filter by name, id, branch or folder"
    aria-label="Filter sessions"
    class="mb-3 h-11 w-full rounded-lg border bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
  />
  {#if !shown.length}<p class="text-muted-foreground">No session matches "{filter}".</p>{/if}
  <ul class="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-3 p-0">
    {#each shown as s (s.id)}
      {@const wt = worktreeName(s.root)}
      <li class="min-w-0">
        <a href={sessionsHref({ host, instance, session: s.id })} class="block min-h-11 min-w-0 no-underline">
          <Card.Root size="sm" class="gap-1">
            <Card.Content class="grid gap-1">
              {@const title = sessionTitle(s)}
              <div class="flex flex-wrap items-start gap-2">
                <span class="min-w-0 flex-1 [overflow-wrap:anywhere] {title ? 'font-semibold' : 'font-normal text-muted-foreground'}">{title ?? "Untitled session"}</span>
                {#each liveBadges(s) as b (b.label)}<Badge variant="outline" class={b.class}>{b.label}</Badge>{/each}
                {#if wt}<Badge variant="outline">work tree</Badge>{/if}
              </div>
              <div class="flex flex-wrap gap-x-2 text-muted-foreground">
                {#each sessionDetail(s, now) as part, i (i)}
                  <span class={i === 0 ? "font-mono" : "min-w-0 [overflow-wrap:anywhere]"}>{part}</span>
                {/each}
                {#if wt}<span class="min-w-0 [overflow-wrap:anywhere]">{wt}</span>{/if}
              </div>
            </Card.Content>
          </Card.Root>
        </a>
      </li>
    {/each}
  </ul>
{/if}
