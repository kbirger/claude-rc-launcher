<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { cn } from "#lib/utils.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { SessionsLink } from "#lib/features/sessions";
  import InstanceLogs from "./InstanceLogs.svelte";
  import { createInstancesModel } from "./model.svelte";
  import type { Instance } from "./api";

  let { host, startError = "" }: { host: string; startError?: string } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the list (#key) when the host changes.
  const model = createInstancesModel({ host: untrack(() => host), client: useQueryClient(), startError: () => startError });
  let open = $state<Record<string, true>>({});
  const now = $derived(model.now);

  function uptime(state: string, startedAt: string | null): string {
    if (state !== "active" || !startedAt) return "—";
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return "—";
    const s = Math.max(0, Math.floor((now - t) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function badge(state: string): string {
    return state === "active" ? "active" : state === "failed" ? "failed" : "other";
  }

  function stop(i: Instance) {
    if (confirm(`Stop ${i.name}?`)) model.stop(i.id);
  }

  function toggleLogs(id: string) {
    if (id in open) {
      const { [id]: _, ...rest } = open;
      open = rest;
    } else open = { ...open, [id]: true };
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
        <Card.Header>
          <Card.Title class="text-base font-semibold [overflow-wrap:anywhere]">{r.name}</Card.Title>
          <Card.Action>
            {#if r.pending}
              <Badge variant="outline" class="text-warning">{r.pending}...</Badge>
            {:else if i}
              <Badge variant={badge(i.state) === "failed" ? "destructive" : "outline"} class={badge(i.state) === "active" ? "text-success" : badge(i.state) === "other" ? "text-warning" : ""}>{i.state}</Badge>
            {/if}
          </Card.Action>
        </Card.Header>
        {#if i}
          <Card.Content class="grid gap-2">
            <div class="grid gap-0.5 text-muted-foreground">
              <div class="[overflow-wrap:anywhere]">{i.path}</div>
              {#if i.user}<div>{i.user}</div>{/if}
              <div>{uptime(i.state, i.startedAt)}</div>
            </div>
            <div class="flex gap-2">
              <Button variant="outline" size="touch" disabled={!!r.pending} onclick={() => toggleLogs(i.id)}>{i.id in open ? "Hide logs" : "Logs"}</Button>
              <SessionsLink {host} instance={i.id} />
              <Button variant="destructive" size="touch" disabled={!!r.pending} onclick={() => stop(i)}>Stop</Button>
            </div>
            {#if i.id in open}<InstanceLogs {host} id={i.id} />{/if}
          </Card.Content>
        {/if}
      </Card.Root>
    </li>
  {/each}
</ul>
