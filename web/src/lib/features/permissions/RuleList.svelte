<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { cn } from "#lib/utils.js";
  import type { Layer } from "./api";
  import { flatRules, scopeBadge, scopeLabel } from "./format";
  import RuleSheet from "./RuleSheet.svelte";

  // One list for Deny, Ask and Allow, in the order that Claude Code evaluates them (the first match wins, whatever the file).
  // The badge of a rule says which file it comes from. The files are listed below with their state.
  // A tap on a file badge of a rule opens the sheet to remove the rule from that file. "Add rule" opens it to add one.
  // `session` is undefined for the user file of an instance.
  let { layers, host, instance, session }: { layers: Layer[]; host: string; instance: string; session?: string } = $props();

  // The sheet is mounted only while it is open, and it is mounted fresh for each change (it reads its start values once).
  // A remove sheet gets only the file that holds the rule, so it cannot show another file. A file that is read-only has no remove.
  type Sheet = { mode: "add" } | { mode: "remove"; layer: Layer; initial: { raw: string; list: "allow" | "ask" | "deny" } };
  let sheet = $state<Sheet | null>(null);
  const removable = (scope: string) => layers.find((l) => l.scope === scope && l.writable && l.state === "ok");

  let only = $state<string | null>(null);
  const withRules = $derived(layers.filter((l) => l.rules.length > 0));
  // A file that no longer has rules (the data changed) cannot filter: show everything.
  const active = $derived(only !== null && withRules.some((l) => l.scope === only) ? only : null);
  const groups = $derived(flatRules(layers, active ?? undefined));
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<div class="grid min-w-0 gap-3">
  <Button type="button" variant="outline" size="touch" onclick={() => (sheet = { mode: "add" })}>Add rule</Button>
  {#if withRules.length > 0}
    <div class="flex flex-wrap gap-1.5" role="group" aria-label="Filter by file">
      <Button type="button" variant={active === null ? "secondary" : "outline"} size="sm" class="h-9 rounded-full px-3" aria-pressed={active === null} onclick={() => (only = null)}>All</Button>
      {#each withRules as l (l.scope)}
        <Button type="button" variant={active === l.scope ? "secondary" : "outline"} size="sm" class="h-9 rounded-full px-3" aria-pressed={active === l.scope} onclick={() => (only = l.scope)}>{scopeBadge(l.scope)}</Button>
      {/each}
    </div>
  {:else}
    <p class="m-0 text-sm text-muted-foreground">No permission rules in these files.</p>
  {/if}

  {#each groups as g (g.list)}
    <section class="min-w-0 rounded-lg border bg-card px-3 py-2">
      <h4 class="m-0 text-xs font-semibold text-muted-foreground uppercase">{g.title} ({g.rules.length})</h4>
      <ul class="m-0 min-w-0 list-none p-0">
        {#each g.rules as r (r.raw)}
          <li data-rule class="min-w-0 border-b py-2 last:border-b-0">
            <code class={cn(wrap, "font-mono text-xs")}>{r.raw}</code>
            <span class="mt-1 flex flex-wrap gap-1">
              {#each r.scopes as s (s)}
                {@const file = removable(s)}
                <Badge variant="outline">{scopeBadge(s)}</Badge>
                {#if file}<Button type="button" variant="ghost" size="sm" class="h-9 px-2 text-xs" aria-label="Remove {r.raw} from {scopeLabel(s)}" onclick={() => (sheet = { mode: "remove", layer: file, initial: { raw: r.raw, list: g.list } })}>Remove</Button>{/if}
              {/each}
            </span>
            {#if r.shadowedBy}<span class="mt-1 block text-xs text-muted-foreground">overridden by {r.shadowedBy.list} in {r.shadowedBy.scope}</span>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <section class="min-w-0 rounded-lg border bg-card px-3 py-2">
    <h4 class="m-0 text-xs font-semibold text-muted-foreground uppercase">Files</h4>
    <ul class="m-0 min-w-0 list-none p-0">
      {#each layers as l (l.scope)}
        <li class="grid min-w-0 gap-0.5 border-b py-2 last:border-b-0">
          <span class="text-sm font-semibold">{scopeLabel(l.scope)}</span>
          <span class={cn(wrap, "font-mono text-xs text-muted-foreground")}>{l.path ?? "no path"}</span>
          {#if l.resolvedPath}<span class={cn(wrap, "font-mono text-xs text-muted-foreground")}>Resolves to {l.resolvedPath}</span>{/if}
          {#if l.state === "invalid"}
            <span class={cn(wrap, "text-sm text-destructive")}>This file cannot be used: {l.reason}</span>
          {:else if l.state === "unknown-path"}
            <span class={cn(wrap, "text-sm text-muted-foreground")}>The place of this file is not known: {l.reason}</span>
          {:else if l.state === "missing"}
            <span class="text-sm text-muted-foreground">No file.</span>
          {:else}
            <span class="text-xs text-muted-foreground">{l.rules.length} {l.rules.length === 1 ? "rule" : "rules"}</span>
          {/if}
          {#each l.warnings as w (w)}
            <span class={cn(wrap, "text-xs text-muted-foreground")}>Warning: {w}</span>
          {/each}
        </li>
      {/each}
    </ul>
  </section>
</div>

{#if sheet}
  {#key sheet}
    <RuleSheet bind:open={() => true, (v) => { if (!v) sheet = null; }} {host} {instance} {session} mode={sheet.mode} layers={sheet.mode === "add" ? layers : [sheet.layer]} initial={sheet.mode === "remove" ? sheet.initial : undefined} />
  {/key}
{/if}
