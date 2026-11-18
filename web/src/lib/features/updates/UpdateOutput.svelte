<script lang="ts">
  import * as Collapsible from "#lib/components/ui/collapsible/index.js";
  import { tick } from "svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { logsQuery } from "./queries";
  import { followsBottom, outputSummary } from "./updateoutput";

  // `open` is only the start state: a running update opens the panel, a finished one leaves it closed.
  let { host, open: startOpen = false }: { host: string; open?: boolean } = $props();

  const logsQ = createQuery(logsQuery);
  const lines = $derived(logsQ.data?.[host] ?? []);
  // svelte-ignore state_referenced_locally
  let open = $state(startOpen);
  let box = $state<HTMLPreElement>();
  let follow = true;

  function onscroll() {
    if (box) follow = followsBottom(box.scrollTop, box.clientHeight, box.scrollHeight);
  }

  // Newest line at the bottom; follow it while the reader has not scrolled up.
  $effect(() => {
    lines.length;
    if (!open || !follow) return;
    void tick().then(() => {
      if (box) box.scrollTop = box.scrollHeight;
    });
  });
</script>

{#if lines.length}
  <Collapsible.Root bind:open class="basis-full">
    <Collapsible.Trigger class="flex min-h-11 cursor-pointer items-center text-muted-foreground">{outputSummary(lines.length)}</Collapsible.Trigger>
    <Collapsible.Content>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable region must be reachable by keyboard -->
      <pre bind:this={box} {onscroll} tabindex="0" role="log" aria-label={`Output of ${host}`} class="max-h-48 overflow-auto rounded-md border bg-card p-2 text-[0.8rem] break-all whitespace-pre-wrap">{lines.map((l) => l.line).join("\n")}</pre>
    </Collapsible.Content>
  </Collapsible.Root>
{/if}
