<script lang="ts">
	import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: RadioGroupPrimitive.ItemProps = $props();
</script>

<RadioGroupPrimitive.Item
	bind:ref
	data-slot="radio-group-item"
	class={cn(
		"border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive group/radio-group-item relative flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		{#if checked}
			<span data-slot="radio-group-indicator" class="bg-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"></span>
		{/if}
	{/snippet}
</RadioGroupPrimitive.Item>
