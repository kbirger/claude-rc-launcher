<script lang="ts" module>
  import type { Component, SvelteComponent } from "svelte";

  export type OverflowItem = { label: string; icon?: Component<any> | (new (...args: any[]) => SvelteComponent<any>); onselect: () => void; destructive?: boolean; disabled?: boolean };
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Dots from "@tabler/icons-svelte/icons/dots";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { cn } from "#lib/utils.js";

  // The common card of the list screens. The header has the title (left) and the status (right). Under it come the subtitle, the content, the action strip, and the footer.
  // `actions` sits on the left of the strip. `actionsEnd` and the overflow menu sit on the right.
  let {
    title,
    titleAside,
    titleEditor,
    subtitle,
    status,
    children,
    footer,
    actions,
    actionsEnd,
    overflow = [],
    overflowLabel = "More actions",
    selected = false,
    pending = false,
    class: className,
    size = "sm",
  }: {
    title: Snippet;
    titleAside?: Snippet;
    titleEditor?: Snippet;
    subtitle?: Snippet;
    status?: Snippet;
    children?: Snippet;
    footer?: Snippet;
    actions?: Snippet;
    actionsEnd?: Snippet;
    overflow?: OverflowItem[];
    overflowLabel?: string;
    selected?: boolean;
    pending?: "starting" | string | false;
    class?: string;
    size?: "default" | "sm";
  } = $props();

  const hasStrip = $derived(!!actions || !!actionsEnd || overflow.length > 0);
</script>

<!-- With selected and pending="starting" together, the dashed muted border wins over the primary ring. -->
<Card.Root
  {size}
  data-slot="entity-card"
  class={cn("gap-2", selected && "ring-2 ring-primary", pending && "opacity-60", pending === "starting" && "ring-0 border border-dashed border-muted-foreground/50", className)}
>
  <Card.Content class="flex flex-col gap-1.5">
    <div class="flex items-start justify-between gap-2">
      <!-- titleEditor replaces the heading (a rename form). titleAside sits next to it, outside the heading (a role pill). -->
      <div class="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {#if titleEditor}
          {@render titleEditor()}
        {:else}
          <h3 class="m-0 min-w-0 text-base leading-tight font-semibold [overflow-wrap:anywhere]">{@render title()}</h3>
        {/if}
        {#if titleAside}{@render titleAside()}{/if}
      </div>
      {#if status}<div class="flex min-h-7 flex-none items-center">{@render status()}</div>{/if}
    </div>
    {#if subtitle}<div class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{@render subtitle()}</div>{/if}
    {#if children}<div class="flex flex-wrap items-center gap-1.5">{@render children()}</div>{/if}
    {#if hasStrip}
      <!-- -mx-2 cancels the ghost buttons' inner padding, so the first and last buttons line up with the text edges. -->
      <div data-slot="entity-card-actions" class="-mx-2 mt-1 flex items-center gap-1">
        {#if actions}<div class="flex min-w-0 flex-wrap items-center gap-1">{@render actions()}</div>{/if}
        <div class="ml-auto flex items-center gap-1">
          {#if actionsEnd}{@render actionsEnd()}{/if}
          {#if overflow.length > 0}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button {...props} variant="ghost" size="icon" class="hover:border-border" aria-label={overflowLabel}>
                    <Dots aria-hidden="true" />
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end" class="w-auto min-w-40">
                {#each overflow as item, n (n)}
                  <DropdownMenu.Item class="min-h-11" variant={item.destructive ? "destructive" : "default"} disabled={item.disabled} onSelect={item.onselect}>
                    {#if item.icon}{@const Icon = item.icon}<Icon aria-hidden="true" />{/if}
                    {item.label}
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/if}
        </div>
      </div>
    {/if}
    {#if footer}{@render footer()}{/if}
  </Card.Content>
</Card.Root>
