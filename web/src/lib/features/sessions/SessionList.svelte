<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Search from "@tabler/icons-svelte/icons/search";
  import Broadcast from "@tabler/icons-svelte/icons/broadcast";
  import * as Card from "#lib/components/ui/card/index.js";
  import { isUnsupported } from "./api";
  import { sessionDetail, sessionMatches, sessionState, sessionsHref, sessionTitle, worktreeName } from "./format";
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
  <!-- The filter is a bar of its own, with a search icon and the count, and a line between it and the list. -->
  <div class="mb-3 grid gap-2 border-b pb-3">
    <div class="relative">
      <Search size={18} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        bind:value={filter}
        placeholder="Filter by name, id, branch or folder"
        aria-label="Filter sessions"
        class="h-11 w-full rounded-lg border bg-card pr-3 pl-10 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
      />
    </div>
    <p class="m-0 text-xs text-muted-foreground" aria-live="polite">{filter ? `${shown.length} of ${q.data.length} sessions` : `${q.data.length} ${q.data.length === 1 ? "session" : "sessions"}`}</p>
  </div>
  {#if !shown.length}<p class="text-muted-foreground">No session matches "{filter}".</p>{/if}
  <ul class="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-3 p-0">
    {#each shown as s (s.id)}
      {@const wt = worktreeName(s.root)}
      <li class="min-w-0">
        <a href={sessionsHref({ host, instance, session: s.id })} class="block min-h-11 min-w-0 no-underline">
          <Card.Root size="sm" class="gap-1">
            <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-1">
              {@const title = sessionTitle(s)}
              {@const st = sessionState(s)}
              <!-- The name has the first line and is cut with an ellipsis when it is too long (the full name is the tooltip). At the end of the line: a Remote Control icon, then a dot (green when live, gray when offline; it pulses while busy). -->
              <div class="flex items-start justify-between gap-2">
                <span data-session-title class="min-w-0 flex-1 truncate {title ? 'font-semibold' : 'font-normal text-muted-foreground'}" title={title}>{title ?? "Untitled session"}</span>
                <span class="flex h-6 flex-none items-center gap-2">
                  {#if st.remoteControl}
                    <span class="text-primary" title="Remote Control" role="img" aria-label="Remote Control"><Broadcast size={16} aria-hidden="true" /></span>
                  {/if}
                  <span class={"size-2.5 rounded-full " + (st.live ? "bg-success" : "bg-muted-foreground/50") + (st.busy ? " animate-pulse" : "")} title={st.title} role="img" aria-label={st.title}></span>
                </span>
              </div>
              <div class="flex flex-wrap gap-x-2 text-muted-foreground">
                {#each sessionDetail(s, now) as part, i (i)}
                  <span class={i === 0 ? "font-mono" : "min-w-0 [overflow-wrap:anywhere]"}>{part}</span>
                {/each}
                {#if wt}<span class="min-w-0 [overflow-wrap:anywhere]">work tree: {wt}</span>{/if}
              </div>
            </Card.Content>
          </Card.Root>
        </a>
      </li>
    {/each}
  </ul>
{/if}
