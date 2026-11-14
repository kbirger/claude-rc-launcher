<script lang="ts">
  // Test helper: EntityCard takes snippets, so this fills each slot with a marker element.
  import type { ComponentProps } from "svelte";
  import EntityCard from "./EntityCard.svelte";
  import Pill from "./Pill.svelte";

  type Slot = "subtitle" | "status" | "content" | "actions" | "actionsEnd";
  let { slots = [], ...rest }: { slots?: Slot[] } & Omit<ComponentProps<typeof EntityCard>, "title" | Slot | "children" | "actionsEnd"> = $props();
</script>

{#snippet title()}Card name{/snippet}
{#snippet subtitle()}<span data-testid="subtitle">Sub</span>{/snippet}
{#snippet status()}<span data-testid="status">Running</span>{/snippet}
{#snippet content()}<Pill>pill one</Pill>{/snippet}
{#snippet actions()}<button type="button" data-testid="actions">Left</button>{/snippet}
{#snippet actionsEnd()}<button type="button" data-testid="actionsEnd">Right</button>{/snippet}

<EntityCard
  {...rest}
  {title}
  subtitle={slots.includes("subtitle") ? subtitle : undefined}
  status={slots.includes("status") ? status : undefined}
  children={slots.includes("content") ? content : undefined}
  actions={slots.includes("actions") ? actions : undefined}
  actionsEnd={slots.includes("actionsEnd") ? actionsEnd : undefined}
/>
