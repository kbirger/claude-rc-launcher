<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Button } from "#lib/components/ui/button/index.js";
  import { downloadUrl } from "./api";
  import { baseName, humanSize } from "./format";
  import { previewQuery } from "./queries";

  // `abs`: `file` is the absolute path of a touched file outside the session folder.
  type Props = { host: string; instance: string; session: string; file: string; abs?: boolean; back: string };
  let { host, instance, session, file, abs = false, back }: Props = $props();

  const q = createQuery(() => previewQuery(host, instance, session, file, abs));
  const name = $derived(baseName(file));
</script>

<div class="grid gap-3">
  <Button variant="outline" size="touch" href={back}>Back</Button>
  {#if q.isPending}
    <p class="text-muted-foreground">Loading file...</p>
  {:else if q.error}
    <p class="error">{q.error.message}</p>
  {:else if q.data}
    {@const p = q.data}
    <div class="grid gap-1">
      <div class="font-semibold [overflow-wrap:anywhere]">{p.name}</div>
      {#if abs}
        <div class="text-sm text-muted-foreground [overflow-wrap:anywhere]">{file}</div>
        <div class="text-sm text-muted-foreground">outside the session folder</div>
      {/if}
      <div class="text-muted-foreground">{humanSize(p.size)}</div>
    </div>
    {#if p.kind === "text"}
      {#if p.truncated}
        <p class="text-sm text-warning">Showing only the start of {humanSize(p.size)}. Download the file for the rest.</p>
      {/if}
      <pre class="m-0 overflow-auto rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{p.text ?? ""}</pre>
    {:else}
      <p class="text-muted-foreground">This file is not text, so it has no preview.</p>
    {/if}
    <Button size="touch" href={downloadUrl(host, instance, session, file, { abs })} download={name}>Download</Button>
  {/if}
</div>
