<script lang="ts">
  import ChevronDown from "@tabler/icons-svelte/icons/chevron-down";
  import { buttonVariants } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import type { HostInfo } from "./api";

  // The nodes that the Sessions and Instances views show: one button with a menu of checkboxes, so it takes the same room for any number of nodes.
  // Nothing selected means all nodes. A node that does not answer stays in the menu: its status is in the text.
  let { hosts, selected, ontoggle, onclear }: { hosts: HostInfo[]; selected: string[]; ontoggle: (id: string) => void; onclear: () => void } = $props();

  const label = $derived(selected.length === 0 ? "all" : selected.length === 1 ? (hosts.find((h) => h.id === selected[0])?.name ?? selected[0]) : `${selected.length} of ${hosts.length}`);
</script>

{#if hosts.length > 1}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class={buttonVariants({ variant: "outline", size: "touch" }) + " w-fit max-w-full justify-between"} aria-label="Filter by node">
      <span class="truncate">Nodes: {label}</span>
      <ChevronDown size={18} aria-hidden="true" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="max-h-[60dvh] min-w-56 overflow-y-auto">
      <DropdownMenu.CheckboxItem class="min-h-11" checked={selected.length === 0} onCheckedChange={() => onclear()}>All nodes</DropdownMenu.CheckboxItem>
      <DropdownMenu.Separator />
      {#each hosts as h (h.id)}
        <DropdownMenu.CheckboxItem class="min-h-11" checked={selected.includes(h.id)} onCheckedChange={() => ontoggle(h.id)}>
          <span class="[overflow-wrap:anywhere]">{h.name}</span>{#if h.status !== "ok"}<span class="text-xs text-muted-foreground">{h.status}</span>{/if}
        </DropdownMenu.CheckboxItem>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
