<script lang="ts">
  // Test helper: EntityCard takes snippets, so this fills each slot with a marker element.
  import type { ComponentProps } from "svelte";
  import EntityCard from "./EntityCard.svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";

  type Slot = "subtitle" | "status" | "content" | "actions" | "actionsEnd" | "footer" | "titleAside" | "titleEditor";
  let {
    slots = [],
    ...rest
  }: { slots?: Slot[] } & Omit<
    ComponentProps<typeof EntityCard>,
    "title" | Slot | "children" | "footer" | "actionsEnd"
  > = $props();
</script>

{#snippet title()}Card name{/snippet}
{#snippet subtitle()}<span data-testid="subtitle">Sub</span>{/snippet}
{#snippet status()}<span data-testid="status">Running</span>{/snippet}
{#snippet content()}<Badge>pill one</Badge>{/snippet}
{#snippet footer()}<div data-testid="footer">Foot</div>{/snippet}
{#snippet titleAside()}<span data-testid="aside">hub</span>{/snippet}
{#snippet titleEditor()}<form data-testid="editor"><input aria-label="Node name" /></form>{/snippet}
{#snippet actions()}<button type="button" data-testid="actions">Left</button>{/snippet}
{#snippet actionsEnd()}<button type="button" data-testid="actionsEnd">Right</button>{/snippet}

<EntityCard
  {...rest}
  {title}
  subtitle={slots.includes("subtitle") ? subtitle : undefined}
  status={slots.includes("status") ? status : undefined}
  children={slots.includes("content") ? content : undefined}
  footer={slots.includes("footer") ? footer : undefined}
  titleAside={slots.includes("titleAside") ? titleAside : undefined}
  titleEditor={slots.includes("titleEditor") ? titleEditor : undefined}
  actions={slots.includes("actions") ? actions : undefined}
  actionsEnd={slots.includes("actionsEnd") ? actionsEnd : undefined}
/>
