<script lang="ts">
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLLabelAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLLabelAttributes, HTMLLabelElement> = $props();
</script>

<label
	bind:this={ref}
	data-slot="field-label"
	class={cn(
		"group/field-label peer/field-label flex w-fit cursor-pointer gap-2 text-sm leading-snug group-data-[disabled=true]/field:opacity-50 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 *:data-[slot=field]:p-3 has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</label>
