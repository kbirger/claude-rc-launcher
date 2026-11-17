<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
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

  const uid = $props.id();
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
        <span id="{uid}-file" class="text-sm font-medium">File</span>
        <Tabs.Root value={layer?.scope ?? ""} onValueChange={(v) => (picked = v)}>
          <Tabs.List aria-labelledby="{uid}-file" class="group-data-horizontal/tabs:h-auto w-full">
            {#each offered as l (l.scope)}
              <Tabs.Trigger value={l.scope} class="h-11 text-sm">{scopeBadge(l.scope)}</Tabs.Trigger>
            {/each}
          </Tabs.List>
        </Tabs.Root>
      {/if}
      {#each blocked as l (l.scope)}
        <p class="m-0 text-sm text-muted-foreground {wrap}">{scopeBadge(l.scope)}: {l.reason ?? "The node cannot tell where Claude Code keeps this file."} It cannot be changed here.</p>
      {/each}
      {#if offered.length === 0 && blocked.length === 0}<p class="m-0 text-sm text-muted-foreground">No file can be changed here.</p>{/if}

      <span id="{uid}-list" class="text-sm font-medium">List</span>
      <Tabs.Root value={list} onValueChange={(v) => (list = v as typeof list)}>
        <Tabs.List aria-labelledby="{uid}-list" class="group-data-horizontal/tabs:h-auto w-full">
          {#each LISTS as l (l)}
            <Tabs.Trigger value={l} class="h-11 text-sm" disabled={mode === "remove"}>{listLabel(l)}</Tabs.Trigger>
          {/each}
        </Tabs.List>
      </Tabs.Root>

      <div class="grid gap-1">
        <Label for="rule-input">Rule</Label>
        <Input id="rule-input" class="h-11 font-mono text-sm" bind:value={rule} readonly={mode === "remove"} autocapitalize="off" autocomplete="off" spellcheck="false" />
      </div>
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
        <div class="flex min-h-11 items-center gap-3 {wrap}">
          <Checkbox id="nudge" bind:checked={nudge} disabled={live !== true} />
          <Label for="nudge" class="leading-snug font-normal">{NUDGE_LABEL}</Label>
        </div>
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
