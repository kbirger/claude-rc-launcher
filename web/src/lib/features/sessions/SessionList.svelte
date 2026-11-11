<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { isUnsupported } from "./api";
  import { ago, sessionsHref, worktreeName } from "./format";
  import { sessionsQuery } from "./queries";

  let { host, instance, now }: { host: string; instance: string; now: number } = $props();

  const q = createQuery(() => sessionsQuery(host, instance));
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
  <ul class="m-0 grid list-none gap-3 p-0">
    {#each q.data as s (s.id)}
      {@const wt = worktreeName(s.root)}
      <li>
        <a href={sessionsHref({ host, instance, session: s.id })} class="block min-h-11 no-underline">
          <Card.Root size="sm" class="gap-1">
            <Card.Content class="grid gap-1">
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate font-semibold">{s.branch ?? "no branch"}</span>
                {#if wt}<Badge variant="outline">work tree</Badge>{/if}
              </div>
              <div class="flex gap-2 text-muted-foreground">
                <span class="font-mono">{s.id.slice(0, 8)}</span>
                <span>{ago(s.lastActiveAt, now)}</span>
                {#if wt}<span class="min-w-0 truncate">{wt}</span>{/if}
              </div>
            </Card.Content>
          </Card.Root>
        </a>
      </li>
    {/each}
  </ul>
{/if}
