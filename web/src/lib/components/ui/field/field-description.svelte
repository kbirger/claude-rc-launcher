<script lang="ts">
  import { cn, type WithElementRef } from "#lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
  bind:this={ref}
  data-slot="field-description"
  class={cn("text-muted-foreground text-left text-xs leading-normal font-normal [overflow-wrap:anywhere]", className)}
  {...restProps}
>
  {@render children?.()}
</div>
