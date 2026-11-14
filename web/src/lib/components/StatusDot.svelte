<script lang="ts">
  import { cn } from "#lib/utils.js";

  // A plain colour dot for a status. The label is the tooltip and the name for a screen reader.
  let { tone, label, pulse = false, class: className }: { tone: "ok" | "warn" | "bad" | "idle"; label: string; pulse?: boolean; class?: string } = $props();
  const toneClass = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive", idle: "bg-muted-foreground" } as const;
</script>

<span class={cn("size-2.5 flex-none rounded-full", toneClass[tone], pulse && "animate-pulse", className)} role="img" aria-label={label} title={label}></span>
