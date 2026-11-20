<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import Search from "@tabler/icons-svelte/icons/search";
  import { Input } from "#lib/components/ui/input/index.js";
  import { NodeFilter, inFilter, type HostInfo } from "../hosts";
  import { instancesQuery } from "../instances/queries";
  import { globalMatches } from "./format";
  import { allSessionsQuery } from "./queries";
  import SessionCard from "./SessionCard.svelte";
  import { sessionKey, sortSessions } from "./sessionorder";

  // The sessions of all nodes. `nodes` is the node selection (empty: all). `host` and `instance` narrow the list to one instance (from the address):
  // the heading then names the instance and its node, and the node filter is gone, because the choice is made.
  let { hosts, nodes, host, instance, now, ontoggle, onclear }: { hosts: HostInfo[]; nodes: string[]; host: string; instance: string; now: number; ontoggle: (id: string) => void; onclear: () => void } = $props();

  const q = createQuery(() => allSessionsQuery());
  let filter = $state("");
  // The instance filter needs both: an address with only an instance gives no filter.
  const filtered = $derived(!!host && !!instance);

  // For one instance the node selection does not apply: it could hide the sessions of the instance that the user opened.
  const inScope = (nodeId: string) => (filtered ? nodeId === host : inFilter(nodes, nodeId));
  const scoped = $derived((q.data?.sessions ?? []).filter((s) => inScope(s.host.id) && (!filtered || s.instance.id === instance)));
  const shown = $derived(sortSessions(scoped.filter((s) => globalMatches(s, filter))));
  // A node that did not answer is named, so that a missing node is not mistaken for "no sessions".
  const notices = $derived(
    (q.data?.hosts ?? [])
      .filter((h) => h.status !== "ok" && inScope(h.id))
      .map((h) => ({ id: h.id, text: `${h.name}: ${h.status === "unsupported" ? "update this node to list its sessions" : h.status === "offline" ? "not answering" : (h.error ?? "error")}` })),
  );
  // The name of the instance comes from its sessions. An instance without sessions gets its name from the instance list.
  const rowName = $derived((q.data?.sessions ?? []).find((s) => s.host.id === host && s.instance.id === instance)?.instance.name);
  const names = createQuery(() => ({ ...instancesQuery(host), refetchInterval: false as const, enabled: filtered && !rowName }));
  const instanceName = $derived(rowName ?? names.data?.find((i) => i.id === instance)?.name ?? instance.slice(0, 8));
  const nodeName = $derived(hosts.find((h) => h.id === host)?.name ?? q.data?.hosts.find((h) => h.id === host)?.name ?? host);
</script>

<h2 class="font-heading mb-3 text-lg font-bold [overflow-wrap:anywhere]">{filtered ? `Sessions: ${instanceName} on ${nodeName}` : "Sessions"}</h2>
{#if q.isPending}
  <p class="text-muted-foreground">Loading sessions...</p>
{:else if q.error}
  <Alert.Root variant="destructive"><Alert.Description>{q.error.message}</Alert.Description></Alert.Root>
{:else}
  <!-- The node chips and the filter are a bar of their own, with a line between it and the list. It sticks under the header (61px) so it stays in view while the list scrolls. Up to 480px wide the header is hidden, so it sticks to the top there. -->
  <div class="sticky top-[env(safe-area-inset-top)] min-[481px]:top-[61px] z-30 -mx-4 mb-3 grid gap-2 border-b bg-background px-4 pt-3 pb-3">
    <!-- The node filter is one button, so it takes the same room for any number of nodes. It shares the row with the text filter. -->
    <div class="flex gap-2">
      {#if hosts.length > 1 && !filtered}<div class="min-w-0 max-w-[50%] shrink-0"><NodeFilter {hosts} selected={nodes} {ontoggle} {onclear} /></div>{/if}
      <div class="relative min-w-0 flex-1">
        <Search size={18} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type="search" bind:value={filter} placeholder="Filter sessions" aria-label="Filter sessions" class="h-11 pl-10" />
      </div>
    </div>
    <p class="text-xs text-muted-foreground" aria-live="polite">{filter ? `${shown.length} of ${scoped.length} sessions` : `${scoped.length} ${scoped.length === 1 ? "session" : "sessions"}`}</p>
  </div>
  {#each notices as n (n.id)}
    <Alert.Root class="mb-3"><Alert.Description>{n.text}</Alert.Description></Alert.Root>
  {/each}
  {#if !scoped.length}
    {#if !notices.length}<p class="text-muted-foreground">No sessions yet.</p>{/if}
  {:else if !shown.length}
    <p class="text-muted-foreground">No session matches "{filter}".</p>
  {:else}
    <ul class="grid grid-cols-[minmax(0,1fr)] gap-3">
      {#each shown as s (sessionKey(s))}
        <li class="min-w-0"><SessionCard {s} {now} where={!filtered} /></li>
      {/each}
    </ul>
  {/if}
{/if}
