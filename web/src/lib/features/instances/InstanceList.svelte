<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import ChevronDown from "@tabler/icons-svelte/icons/chevron-down";
  import FileText from "@tabler/icons-svelte/icons/file-text";
  import Pause from "@tabler/icons-svelte/icons/player-pause";
  import Play from "@tabler/icons-svelte/icons/player-play";
  import Stop from "@tabler/icons-svelte/icons/player-stop";
  import { cn } from "#lib/utils.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { SessionsLink } from "#lib/features/sessions";
  import InstanceLogs from "./InstanceLogs.svelte";
  import { createInstancesModel } from "./model.svelte";
  import { isPaused, stateLabel, stateTone } from "./state";
  import type { Instance } from "./api";

  let { host, startError = "" }: { host: string; startError?: string } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the list (#key) when the host changes.
  const model = createInstancesModel({ host: untrack(() => host), client: useQueryClient(), startError: () => startError });
  // The instances whose logs are open in the card.
  let open = $state<Record<string, true>>({});
  const now = $derived(model.now);

  function uptime(state: string, startedAt: string | null): string {
    if (state !== "active" || !startedAt) return "";
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, Math.floor((now - t) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `up ${d}d ${h}h`;
    if (h > 0) return `up ${h}h ${m}m`;
    return `up ${m}m`;
  }

  function toggleLogs(id: string) {
    if (id in open) {
      const { [id]: _, ...rest } = open;
      open = rest;
    } else open = { ...open, [id]: true };
  }

  function stop(i: Instance) {
    if (confirm(`Stop ${i.name}? This removes it from the list. Use Pause to keep it.`)) model.stop(i.id);
  }
</script>

{#each model.errors as e}<p class="error">{e}</p>{/each}
{#if model.loaded && model.rows.length === 0}
  <p class="muted empty">No running instances. Tap New to start one.</p>
{/if}
<ul class="m-0 grid list-none gap-3 p-0">
  {#each model.rows as r (r.key)}
    {@const i = r.instance}
    <li>
      <Card.Root size="sm" class={cn("gap-2", r.pending && "opacity-60", r.pending === "starting" && "ring-0 border border-dashed border-muted-foreground/50")}>
        <Card.Content class="flex flex-col gap-1.5">
          <div class="flex items-start justify-between gap-2">
            <h3 class="m-0 text-base leading-tight font-semibold [overflow-wrap:anywhere]">{r.name}</h3>
            {#if r.pending}
              <Badge variant="outline" class="flex-none text-warning">{r.pending}...</Badge>
            {:else if i}
              <Badge variant={stateTone(i.state) === "failed" ? "destructive" : "outline"} class={cn("flex-none", stateTone(i.state) === "ok" ? "text-success" : stateTone(i.state) === "other" ? "text-warning" : "")}>{stateLabel(i.state)}</Badge>
            {/if}
          </div>
          {#if i}
            <p class="m-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{i.path}</p>
            {#if i.user || uptime(i.state, i.startedAt)}
              <p class="m-0 text-xs text-muted-foreground">{[i.user, uptime(i.state, i.startedAt)].filter(Boolean).join(" · ")}</p>
            {/if}
            <!-- One action row. -mx-2 cancels the ghost buttons' inner padding, so the first and last icons line up with the text edges. -->
            <div class="-mx-2 mt-1 flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" class="h-8 px-2 hover:border-border" disabled={!!r.pending} onclick={() => toggleLogs(i.id)} aria-expanded={i.id in open}>
                <FileText aria-hidden="true" />Logs<ChevronDown class={cn("transition-transform", i.id in open && "rotate-180")} aria-hidden="true" />
              </Button>
              <SessionsLink {host} instance={i.id} />
              <div class="ml-auto flex items-center gap-1">
                {#if isPaused(i.state)}
                  <Button variant="ghost" size="icon" class="hover:border-border" disabled={!!r.pending} onclick={() => model.resume(i.id)} aria-label="Resume {r.name}" title="Resume">
                    <Play aria-hidden="true" />
                  </Button>
                {:else}
                  <Button variant="ghost" size="icon" class="hover:border-border" disabled={!!r.pending} onclick={() => model.pause(i.id)} aria-label="Pause {r.name}" title="Pause: stops the service and keeps the instance">
                    <Pause aria-hidden="true" />
                  </Button>
                {/if}
                <Button variant="ghost" size="icon" class="text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive" disabled={!!r.pending} onclick={() => stop(i)} aria-label="Stop {r.name}" title="Stop: removes the instance">
                  <Stop aria-hidden="true" />
                </Button>
              </div>
            </div>
          {/if}
        </Card.Content>
        {#if i && i.id in open}
          <Card.Content><InstanceLogs {host} id={i.id} /></Card.Content>
        {/if}
      </Card.Root>
    </li>
  {/each}
</ul>
