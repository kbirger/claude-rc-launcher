<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { ToggleGroup, ToggleGroupItem } from "#lib/components/ui/toggle-group/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import type { BlockedCall, Layer, NudgeResult } from "./api";
  import { blockWarning, confirmWords, listLabel, NOT_LIVE_NOTE, NUDGE_LABEL, NUDGE_SENT, nudgeFailure, RELOAD_MESSAGE, scopeBadge, scopeWarning, summaryOf } from "./format";
  import { addRuleMutation, removeRuleMutation } from "./mutations";
  import { suggestRules } from "./suggest";

  // Confirms one change to one file. Mount it fresh for each change: it reads `initial` and `call` once, when it is created.
  // Without a `session` it uses the user routes and offers only the user file.
  let { open = $bindable(false), host, instance, session, layers, mode, initial, call, live }: {
    open: boolean;
    host: string;
    instance: string;
    session?: string;
    layers: Layer[];
    mode: "add" | "remove";
    initial?: { raw: string; list: "allow" | "ask" | "deny" };
    call?: BlockedCall;
    /** Whether the session runs. Decides the default of the "try again" box. */
    live?: boolean;
  } = $props();

  const client = useQueryClient();
  const add = createMutation(() => addRuleMutation(host, instance, session, client));
  const remove = createMutation(() => removeRuleMutation(host, instance, session, client));
  const mutation = $derived(mode === "add" ? add : remove);

  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  const LISTS = ["allow", "ask", "deny"] as const;
  const offered = $derived(layers.filter((l) => (session !== undefined || l.scope === "user") && l.writable && l.path !== null && (l.state === "ok" || l.state === "missing") && (l.scope === "user" || l.scope === "project" || l.scope === "local")));
  const blocked = $derived(layers.filter((l) => !offered.includes(l) && (session !== undefined || l.scope === "user") && l.state === "unknown-path"));
  const suggestions = $derived(call ? suggestRules(call) : []);

  let list = $state<"allow" | "ask" | "deny">(untrack(() => initial?.list ?? "allow"));
  let rule = $state(untrack(() => initial?.raw ?? (call ? (suggestRules(call)[0]?.raw ?? "") : "")));
  let picked = $state<string | null>(null);
  let understood = $state(false);
  let error = $state<string | null>(null);
  let nudge = $state(untrack(() => live === true));
  let result = $state<NudgeResult | null>(null);
  // A nudge only makes sense for a rule on the allow list. The box keeps its state while it is hidden.
  const canNudge = $derived(mode === "add" && call !== undefined && session !== undefined && list === "allow");

  // The chosen file, or the first one offered. A file that left the list (the data changed) cannot stay chosen.
  const layer = $derived(offered.find((l) => l.scope === picked) ?? offered[0]);
  const trimmed = $derived(rule.trim());
  const needsTap = $derived(call?.reason === "user_rejected" && !understood);
  const warnings = $derived([layer ? scopeWarning(layer.scope) : undefined, call ? blockWarning(call.reason) : undefined].filter((w): w is string => w !== undefined));

  async function save() {
    if (!layer || trimmed === "" || mutation.isPending) return;
    error = null;
    try {
      const edit = { scope: layer.scope as "user" | "project" | "local", list, rule: trimmed, expectedHash: layer.hash ?? null };
      if (mode === "add") {
        const asked = canNudge && nudge && live === true;
        const out = await add.mutateAsync(asked ? { ...edit, nudge: true } : edit);
        // An older node ignores the flag and answers without a `nudge` key.
        if (out.nudge || asked) {
          result = out.nudge ?? { sent: false, reason: "unsupported" };
          return;
        }
      } else {
        await remove.mutateAsync(edit);
      }
      open = false;
    } catch (e) {
      error = e instanceof ApiError && e.status === 409 ? RELOAD_MESSAGE : e instanceof Error ? e.message : "The change failed.";
    }
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="bottom" class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]">
    <Sheet.Header>
      <Sheet.Title>{mode === "add" ? "Add a rule" : "Remove a rule"}</Sheet.Title>
      <Sheet.Description class="sr-only">Choose the file and the list, then confirm the change.</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      {#if call}
        <details class="text-sm">
          <summary class="cursor-pointer {wrap}">Blocked: {summaryOf(call)}</summary>
          <p class="m-0 mt-1 whitespace-pre-wrap text-muted-foreground {wrap}">{call.text}</p>
        </details>
      {/if}

      {#if offered.length > 1}
        <ToggleGroup type="single" variant="outline" aria-label="File" class="w-full" bind:value={() => layer?.scope ?? "", (v) => { if (v) picked = v; }}>
          {#each offered as l (l.scope)}
            <ToggleGroupItem value={l.scope} class="h-11 min-w-0 flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary data-[state=on]:hover:text-primary-foreground">{scopeBadge(l.scope)}</ToggleGroupItem>
          {/each}
        </ToggleGroup>
      {/if}
      {#each blocked as l (l.scope)}
        <p class="m-0 text-sm text-muted-foreground {wrap}">{scopeBadge(l.scope)}: {l.reason ?? "The node cannot tell where Claude Code keeps this file."} It cannot be changed here.</p>
      {/each}
      {#if offered.length === 0 && blocked.length === 0}<p class="m-0 text-sm text-muted-foreground">No file can be changed here.</p>{/if}

      <ToggleGroup type="single" variant="outline" aria-label="List" class="w-full" disabled={mode === "remove"} bind:value={() => list, (v) => { if (v) list = v as typeof list; }}>
        {#each LISTS as l (l)}
          <ToggleGroupItem value={l} class="h-11 min-w-0 flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary data-[state=on]:hover:text-primary-foreground">{listLabel(l)}</ToggleGroupItem>
        {/each}
      </ToggleGroup>

      <label class="grid gap-1 text-sm font-medium">Rule
        <input aria-label="Rule" class="h-11 min-w-0 rounded-md border bg-background px-3 font-mono text-sm" bind:value={rule} readonly={mode === "remove"} autocapitalize="off" autocomplete="off" spellcheck="false" />
      </label>
      {#if mode === "add" && suggestions.length > 1}
        <div class="flex flex-wrap gap-1.5" role="group" aria-label="Other rules">
          {#each suggestions as s (s.raw)}
            <Button type="button" variant={rule === s.raw ? "secondary" : "outline"} size="sm" class="h-auto min-h-9 max-w-full whitespace-normal rounded-full px-3 text-left {wrap}" title={s.label} onclick={() => (rule = s.raw)}>
              {s.raw}{#if s.broad}<Badge variant="outline" class="ml-1.5">broad</Badge>{/if}
            </Button>
          {/each}
        </div>
      {/if}

      {#if layer && trimmed}
        {@const words = confirmWords(mode, list)}
        <p class="m-0 text-sm {wrap}" data-testid="confirm">{words[0]} <code class="font-mono text-xs {wrap}">{trimmed}</code> {words[1]} <code class="font-mono text-xs {wrap}">{layer.path}</code></p>
        {#if layer.resolvedPath && layer.resolvedPath !== layer.path}<p class="m-0 text-xs text-muted-foreground {wrap}">Link to {layer.resolvedPath}</p>{/if}
      {/if}
      {#each warnings as w (w)}<p class="m-0 text-sm text-amber-700 dark:text-amber-400 {wrap}" role="note">{w}</p>{/each}
      {#if canNudge && !result}
        <label class="flex min-h-11 items-center gap-3 text-sm {wrap}">
          <input type="checkbox" bind:checked={nudge} disabled={live !== true} class="size-5 w-auto shrink-0 accent-primary" />{NUDGE_LABEL}
        </label>
        {#if live !== true}<p class="m-0 text-sm text-muted-foreground {wrap}">{NOT_LIVE_NOTE}</p>{/if}
      {/if}
      {#if result}<p class="m-0 text-sm {wrap}" role="status">Rule saved. {result.sent ? NUDGE_SENT : nudgeFailure(result.reason)}</p>{/if}
      {#if error}<p class="m-0 text-sm text-destructive {wrap}" role="alert">{error}</p>{/if}
    </div>
    <Sheet.Footer class="px-4">
      {#if result}
        <Button type="button" size="touch" onclick={() => (open = false)}>Close</Button>
      {:else}
      {#if needsTap}
        <Button type="button" variant="outline" size="touch" onclick={() => (understood = true)}>I understand, you rejected this call</Button>
      {:else}
        <Button type="button" size="touch" variant={mode === "remove" ? "destructive" : "default"} disabled={!layer || trimmed === "" || mutation.isPending} onclick={save}>{mode === "add" ? "Save" : "Remove"}</Button>
      {/if}
      <Button type="button" variant="outline" size="touch" onclick={() => (open = false)}>Cancel</Button>
      {/if}
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
