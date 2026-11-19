<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import Search from "@tabler/icons-svelte/icons/search";
  import X from "@tabler/icons-svelte/icons/x";
  import { Input } from "#lib/components/ui/input/index.js";
  import { NodeChips, inFilter, type HostInfo } from "../hosts";
  import { globalMatches } from "./format";
  import { allSessionsQuery } from "./queries";
  import SessionCard from "./SessionCard.svelte";
  import { sessionKey, sortSessions } from "./sessionorder";

  // The sessions of all nodes. `nodes` is the node selection (empty: all). `host` and `instance` narrow the list to one instance (from the address).
  let { hosts, nodes, host, instance, now, ontoggle, onclear }: { hosts: HostInfo[]; nodes: string[]; host: string; instance: string; now: number; ontoggle: (id: string) => void; onclear: () => void } = $props();

  const q = createQuery(() => allSessionsQuery());
  let filter = $state("");

  const scoped = $derived((q.data?.sessions ?? []).filter((s) => inFilter(nodes, s.host.id) && (!host || !instance || (s.host.id === host && s.instance.id === instance))));
  const shown = $derived(sortSessions(scoped.filter((s) => globalMatches(s, filter))));
  // A node that did not answer is named, so that a missing node is not mistaken for "no sessions".
  const notices = $derived(
    (q.data?.hosts ?? [])
      .filter((h) => h.status !== "ok" && inFilter(nodes, h.id))
      .map((h) => `${h.name}: ${h.status === "unsupported" ? "update this node to list its sessions" : h.status === "offline" ? "not answering" : (h.error ?? "error")}`),
  );
  const instanceName = $derived(instance ? ((q.data?.sessions ?? []).find((s) => s.host.id === host && s.instance.id === instance)?.instance.name ?? instance.slice(0, 8)) : "");
</script>

{#if q.isPending}
  <p class="text-muted-foreground">Loading sessions...</p>
{:else if q.error}
  <Alert.Root variant="destructive"><Alert.Description>{q.error.message}</Alert.Description></Alert.Root>
{:else}
  <!-- The node chips and the filter are a bar of their own, with a line between it and the list. It sticks under the header (61px), so it stays in view while the list scrolls. -->
  <div class="sticky top-[61px] z-30 -mx-4 mb-3 grid gap-2 border-b bg-background px-4 pt-3 pb-3">
    <NodeChips {hosts} selected={nodes} {ontoggle} {onclear} />
    {#if instance}
      <a href="/sessions" aria-label="Remove instance filter" class="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full border px-3 text-sm no-underline">Instance: {instanceName}<X size={16} aria-hidden="true" /></a>
    {/if}
    <div class="relative">
      <Search size={18} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" bind:value={filter} placeholder="Filter sessions" aria-label="Filter sessions" class="h-11 pl-10" />
    </div>
    <p class="text-xs text-muted-foreground" aria-live="polite">{filter ? `${shown.length} of ${scoped.length} sessions` : `${scoped.length} ${scoped.length === 1 ? "session" : "sessions"}`}</p>
  </div>
  {#each notices as n (n)}
    <Alert.Root class="mb-3"><Alert.Description>{n}</Alert.Description></Alert.Root>
  {/each}
  {#if !scoped.length}
    {#if !notices.length}<p class="text-muted-foreground">No sessions yet.</p>{/if}
  {:else if !shown.length}
    <p class="text-muted-foreground">No session matches "{filter}".</p>
  {:else}
    <ul class="grid grid-cols-[minmax(0,1fr)] gap-3">
      {#each shown as s (sessionKey(s))}
        <li class="min-w-0"><SessionCard {s} {now} /></li>
      {/each}
    </ul>
  {/if}
{/if}
