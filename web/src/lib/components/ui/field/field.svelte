<script lang="ts">
  import { cn, type WithElementRef } from "#lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    orientation = "vertical",
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & { orientation?: "vertical" | "horizontal" } = $props();
</script>

<div
  bind:this={ref}
  role="group"
  data-slot="field"
  data-orientation={orientation}
  class={cn(
    "group/field flex w-full gap-2 data-[invalid=true]:text-destructive",
    orientation === "horizontal" ? "flex-row items-start" : "flex-col",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
