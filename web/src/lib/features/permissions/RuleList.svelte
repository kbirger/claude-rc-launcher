<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import XIcon from "@lucide/svelte/icons/x";
  import { cn } from "#lib/utils.js";
  import type { Layer } from "./api";
  import { flatRules, scopeBadge, scopeLabel } from "./format";
  import RuleSheet from "./RuleSheet.svelte";

  // One list for Deny, Ask and Allow, in the order that Claude Code evaluates them (the first match wins, whatever the file).
  // The badge of a rule says which file it comes from. The files are listed below with their state.
  // A tap on a file badge of a rule opens the sheet to remove the rule from that file. "Add rule" opens it to add one.
  // `session` is undefined for the user file of an instance.
  let { layers, host, instance, session }: { layers: Layer[]; host: string; instance: string; session?: string } =
    $props();

  // The sheet is mounted only while it is open, and it is mounted fresh for each change (it reads its start values once).
  // A remove sheet gets only the file that holds the rule, so it cannot show another file. A file that is read-only has no remove.
  type Sheet =
    { mode: "add" } | { mode: "remove"; layer: Layer; initial: { raw: string; list: "allow" | "ask" | "deny" } };
  let sheet = $state<Sheet | null>(null);
  const removable = (scope: string) =>
    layers.find((layer) => layer.scope === scope && layer.writable && layer.state === "ok");

  let only = $state<string | null>(null);
  const withRules = $derived(layers.filter((layer) => layer.rules.length > 0));
  // A file that no longer has rules (the data changed) cannot filter: show everything.
  const active = $derived(only !== null && withRules.some((withRule) => withRule.scope === only) ? only : null);
  const groups = $derived(flatRules(layers, active ?? undefined));
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<div class="grid min-w-0 gap-3">
  <Button type="button" variant="outline" size="touch" onclick={() => (sheet = { mode: "add" })}>Add rule</Button>
  {#if withRules.length > 0}
    <Tabs.Root value={active ?? "all"} onValueChange={(value) => (only = value === "all" ? null : value)}>
      <Tabs.List aria-label="Filter by file" class="group-data-horizontal/tabs:h-auto w-full flex-wrap">
        <Tabs.Trigger value="all" class="h-11 text-sm">All</Tabs.Trigger>
        {#each withRules as layer (layer.scope)}
          <Tabs.Trigger value={layer.scope} class="h-11 text-sm">{scopeBadge(layer.scope)}</Tabs.Trigger>
        {/each}
      </Tabs.List>
    </Tabs.Root>
  {:else}
    <p class="text-sm text-muted-foreground">No permission rules in these files.</p>
  {/if}

  {#each groups as group (group.list)}
    <section class="min-w-0 rounded-lg border bg-card px-3 py-2">
      <h4 class="font-heading text-xs font-semibold text-muted-foreground uppercase">
        {group.title} ({group.rules.length})
      </h4>
      <ul class="min-w-0">
        {#each group.rules as rule (rule.raw)}
          <li data-rule class="flex min-w-0 items-center gap-2 border-b py-2 last:border-b-0">
            <div class="min-w-0 flex-1">
              <code class={cn(wrap, "font-mono text-xs")}>{rule.raw}</code>
              <span class="mt-1 flex flex-wrap gap-1">
                {#each rule.scopes as scope (scope)}<Badge variant="outline">{scopeBadge(scope)}</Badge>{/each}
              </span>
              {#if rule.shadowedBy}<span class="mt-1 block text-xs text-muted-foreground">
                  overridden by {rule.shadowedBy.list} in {rule.shadowedBy.scope}
                </span>{/if}
            </div>
            <!-- One X for each file that holds the rule and can be changed. The label names the file. -->
            {#each rule.scopes as scope (scope)}
              {@const file = removable(scope)}
              {#if file}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  class="shrink-0 text-muted-foreground"
                  aria-label="Remove {rule.raw} from {scopeLabel(scope)}"
                  title="Remove from {scopeLabel(scope)}"
                  onclick={() =>
                    (sheet = { mode: "remove", layer: file, initial: { raw: rule.raw, list: group.list } })}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              {/if}
            {/each}
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <section class="min-w-0 rounded-lg border bg-card px-3 py-2">
    <h4 class="font-heading text-xs font-semibold text-muted-foreground uppercase">Files</h4>
    <ul class="min-w-0">
      {#each layers as layer (layer.scope)}
        <li class="grid min-w-0 gap-0.5 border-b py-2 last:border-b-0">
          <span class="text-sm font-semibold">{scopeLabel(layer.scope)}</span>
          <span class={cn(wrap, "font-mono text-xs text-muted-foreground")}>{layer.path ?? "no path"}</span>
          {#if layer.resolvedPath}<span class={cn(wrap, "font-mono text-xs text-muted-foreground")}>
              Resolves to {layer.resolvedPath}
            </span>{/if}
          {#if layer.state === "invalid"}
            <span class={cn(wrap, "text-sm text-destructive")}>This file cannot be used: {layer.reason}</span>
          {:else if layer.state === "unknown-path"}
            <span class={cn(wrap, "text-sm text-muted-foreground")}>
              The place of this file is not known: {layer.reason}
            </span>
          {:else if layer.state === "missing"}
            <span class="text-sm text-muted-foreground">No file.</span>
          {:else}
            <span class="text-xs text-muted-foreground">
              {layer.rules.length}
              {layer.rules.length === 1 ? "rule" : "rules"}
            </span>
          {/if}
          {#each layer.warnings as warning (warning)}
            <span class={cn(wrap, "text-xs text-muted-foreground")}>Warning: {warning}</span>
          {/each}
        </li>
      {/each}
    </ul>
  </section>
</div>

{#if sheet}
  {#key sheet}
    <RuleSheet
      bind:open={
        () => true,
        (value) => {
          if (!value) sheet = null;
        }
      }
      {host}
      {instance}
      {session}
      mode={sheet.mode}
      layers={sheet.mode === "add" ? layers : [sheet.layer]}
      initial={sheet.mode === "remove" ? sheet.initial : undefined}
    />
  {/key}
{/if}
