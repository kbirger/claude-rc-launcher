<script lang="ts">
  import { Accordion as AccordionPrimitive } from "bits-ui";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import { cn, type WithoutChild } from "#lib/utils.js";

  // The header and the button of an item. The button wraps its text and is at least 44 px high, for touch.
  let {
    ref = $bindable(null),
    class: className,
    level = 3,
    children,
    ...restProps
  }: WithoutChild<AccordionPrimitive.TriggerProps> & {
    level?: AccordionPrimitive.HeaderProps["level"];
  } = $props();
</script>

<AccordionPrimitive.Header {level} class="flex">
  <AccordionPrimitive.Trigger
    bind:ref
    data-slot="accordion-trigger"
    class={cn(
      "flex min-h-11 flex-1 items-center justify-between gap-3 rounded-md py-3 text-left text-base font-bold font-heading break-words outline-none transition-all hover:underline focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
      className,
    )}
    {...restProps}
  >
    {@render children?.()}
    <ChevronDownIcon
      class="pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform duration-200"
      aria-hidden="true"
    />
  </AccordionPrimitive.Trigger>
</AccordionPrimitive.Header>
