<script lang="ts">
  import { Accordion as AccordionPrimitive } from "bits-ui";
  import { cn, type WithoutChild } from "#lib/utils.js";

  // `hiddenUntilFound` defaults to true here: the content stays mounted while closed, with `hidden="until-found"`.
  // Its queries keep running and its state stays, and find in page can open it.
  let {
    ref = $bindable(null),
    class: className,
    hiddenUntilFound = true,
    children,
    ...restProps
  }: WithoutChild<AccordionPrimitive.ContentProps> = $props();
</script>

<AccordionPrimitive.Content
  bind:ref
  data-slot="accordion-content"
  {hiddenUntilFound}
  class="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
  {...restProps}
>
  <div class={cn("pt-0 pb-4", className)}>
    {@render children?.()}
  </div>
</AccordionPrimitive.Content>
