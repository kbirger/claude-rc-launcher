<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Search from "@tabler/icons-svelte/icons/search";
  import Desktop from "@tabler/icons-svelte/icons/device-desktop";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
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
  <p class="text-destructive">{q.error.message}</p>
{:else if !q.data?.length}
  <p class="text-muted-foreground">No sessions yet for this instance.</p>
{:else}
  <!-- The filter is a bar of its own, with a search icon and the count, and a line between it and the list. It sticks under the header (61px), so it stays in view while the list scrolls. -->
  <div class="sticky top-[61px] z-30 -mx-4 mb-3 grid gap-2 border-b bg-background px-4 pt-3 pb-3">
    <div class="relative">
      <Search size={18} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" bind:value={filter} placeholder="Filter by name, id, branch or folder" aria-label="Filter sessions" class="h-11 pl-10" />
    </div>
    <p class="m-0 text-xs text-muted-foreground" aria-live="polite">{filter ? `${shown.length} of ${q.data.length} sessions` : `${q.data.length} ${q.data.length === 1 ? "session" : "sessions"}`}</p>
  </div>
  {#if !shown.length}<p class="text-muted-foreground">No session matches "{filter}".</p>{/if}
  <ul class="grid grid-cols-[minmax(0,1fr)] gap-3">
    {#each shown as s (s.id)}
      {@const wt = worktreeName(s.root)}
      <li class="min-w-0">
        <a href={sessionsHref({ host, instance, session: s.id })} class="block min-h-11 min-w-0 no-underline">
          <Card.Root size="sm" class="gap-1 *:px-4">
            <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-1">
              {@const title = sessionTitle(s)}
              {@const st = sessionState(s)}
              <!-- The name has the first line and is cut with an ellipsis when it is too long (the full name is the tooltip). At the end of the line: the status dot (green when live, gray when offline; it pulses while busy). A Remote Control session shows a desktop icon with the dot on its corner. -->
              <div class="flex items-start justify-between gap-2">
                <span data-session-title class="min-w-0 flex-1 truncate {title ? 'font-semibold' : 'font-normal text-muted-foreground'}" title={title}>{title ?? "Untitled session"}</span>
                <span class="flex h-6 flex-none items-center gap-2">
                  {#if st.remoteControl}
                    <!-- The icon has the text color. The status dot sits on its lower right corner. -->
                    <span class="relative inline-flex" title={`Remote Control. ${st.title}`} role="img" aria-label={`Remote Control. ${st.title}`}>
                      <Desktop size={20} aria-hidden="true" />
                      <span class={"absolute -right-1 -bottom-1 size-2.5 rounded-full ring-2 ring-card " + (st.live ? "bg-success" : "bg-muted-foreground/50") + (st.busy ? " animate-pulse" : "")}></span>
                    </span>
                  {:else}
                    <span class={"size-2.5 rounded-full " + (st.live ? "bg-success" : "bg-muted-foreground/50") + (st.busy ? " animate-pulse" : "")} title={st.title} role="img" aria-label={st.title}></span>
                  {/if}
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
