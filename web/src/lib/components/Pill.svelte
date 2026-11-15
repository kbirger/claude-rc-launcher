<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";

  // A small rounded label. The primary tone is the look of the hub chip.
  let { tone = "default", class: className, children }: { tone?: "default" | "primary"; class?: string; children?: Snippet } = $props();
</script>

<span
  data-slot="pill"
  class={cn(
    "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]",
    tone === "primary" && "border-primary/40 bg-primary/10 font-medium text-primary",
    className,
  )}
>{@render children?.()}</span>
