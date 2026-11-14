<script lang="ts">
  import { cn } from "#lib/utils.js";
  import type { Layer, Rule } from "./api";
  import { scopeLabel } from "./format";

  // The layers are in the order of Claude Code: the first one that sets a rule has the highest precedence.
  let { layers }: { layers: Layer[] } = $props();

  const LISTS = [["allow", "Allow"], ["ask", "Ask"], ["deny", "Deny"]] as const;
  const inList = (l: Layer, list: Rule["list"]) => l.rules.filter((r) => r.list === list);
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<div class="grid min-w-0 gap-3">
  {#each layers as l (l.scope)}
    <section class="grid min-w-0 gap-1.5 rounded-lg border bg-card p-3">
      <h4 class="m-0 min-w-0 text-sm font-semibold">
        {scopeLabel(l.scope)}
        <span class={cn(wrap, "block font-mono text-xs font-normal text-muted-foreground")}>{l.path ?? "no path"}</span>
      </h4>
      {#if l.state === "invalid"}
        <p class={cn(wrap, "m-0 text-sm text-destructive")}>This file cannot be used: {l.reason}</p>
      {:else if l.state === "unknown-path"}
        <p class={cn(wrap, "m-0 text-sm text-muted-foreground")}>The place of this file is not known: {l.reason}</p>
      {:else if l.state === "missing"}
        <p class="m-0 text-sm text-muted-foreground">No file.</p>
      {:else if l.rules.length === 0}
        <p class="m-0 text-sm text-muted-foreground">No permission rules in this file.</p>
      {:else}
        {#each LISTS as [list, title] (list)}
          {@const rules = inList(l, list)}
          {#if rules.length}
            <h5 class="m-0 mt-1 text-xs font-semibold text-muted-foreground uppercase">{title} ({rules.length})</h5>
            <ul class="m-0 min-w-0 list-none p-0">
              {#each rules as r (r.raw)}
                <li class="min-w-0 border-b py-1.5 last:border-b-0">
                  <code class={cn(wrap, "font-mono text-xs")}>{r.raw}</code>
                  {#if r.shadowedBy}<span class="block text-xs text-muted-foreground">overridden by {r.shadowedBy.list} in {r.shadowedBy.scope}</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
      {/if}
      {#each l.warnings as w (w)}
        <p class={cn(wrap, "m-0 text-xs text-muted-foreground")}>Warning: {w}</p>
      {/each}
    </section>
  {/each}
</div>
