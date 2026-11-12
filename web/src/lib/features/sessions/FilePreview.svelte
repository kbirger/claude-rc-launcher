<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Button } from "#lib/components/ui/button/index.js";
  import { downloadUrl } from "./api";
  import CodeView from "./CodeView.svelte";
  import { baseName, humanSize } from "./format";
  import { formatText } from "./formatted";
  import FormattedText from "./FormattedText.svelte";
  import { previewQuery } from "./queries";
  import { showsInPre, viewKind } from "./viewkind";

  // `abs`: `file` is the absolute path of a touched file outside the session folder.
  type Props = { host: string; instance: string; session: string; file: string; abs?: boolean; back: string };
  let { host, instance, session, file, abs = false, back }: Props = $props();

  const q = createQuery(() => previewQuery(host, instance, session, file, abs));
  const name = $derived(baseName(file));
  // Markdown opens rendered. Code and large plain text open wrapped, as the plain view always did.
  let rendered = $state(true);
  let wrap = $state(true);
</script>

<!-- The Wrap switch. It shows with every CodeView. -->
{#snippet wrapSwitch()}
  <Button size="touch" variant={wrap ? "default" : "outline"} aria-pressed={wrap} onclick={() => (wrap = !wrap)}>Wrap</Button>
{/snippet}

<!-- Plain text. A small text is a pre box. A larger text is a CodeView with no language, so a 512 KB file does not make a giant page. -->
{#snippet plain(text: string)}
  {#if showsInPre(text.length)}
    <pre data-preview="plain" class="m-0 overflow-auto rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
  {:else}
    {@render wrapSwitch()}
    <div data-preview="plain" class="min-w-0"><CodeView {text} {wrap} /></div>
  {/if}
{/snippet}

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
      {@const text = p.text ?? ""}
      {@const plan = viewKind(p.name, text.length)}
      {#if plan.kind === "markdown"}
        {#await formatText(p.name, text)}
          <p class="text-muted-foreground">Rendering...</p>
        {:then f}
          {#if f.kind === "markdown"}
            <div class="flex gap-2" role="group" aria-label="Markdown view">
              <Button class="flex-1" size="touch" variant={rendered ? "default" : "outline"} aria-pressed={rendered} onclick={() => (rendered = true)}>Rendered</Button>
              <Button class="flex-1" size="touch" variant={rendered ? "outline" : "default"} aria-pressed={!rendered} onclick={() => (rendered = false)}>Source</Button>
            </div>
            {#if rendered}
              <div data-preview="rendered" class="min-w-0 rounded-lg border bg-card p-3"><FormattedText html={f.html} /></div>
            {:else}
              {@render wrapSwitch()}
              <div data-preview="source" class="min-w-0"><CodeView {text} language="markdown" {wrap} /></div>
            {/if}
          {:else}
            {#if f.note}<p class="text-sm text-muted-foreground">{f.note}</p>{/if}
            {@render plain(text)}
          {/if}
        {/await}
      {:else if plan.kind === "code"}
        {@render wrapSwitch()}
        <div data-preview="code" class="min-w-0"><CodeView {text} language={plan.language} {wrap} /></div>
      {:else}
        {#if plan.note}<p class="text-sm text-muted-foreground">{plan.note}</p>{/if}
        {@render plain(text)}
      {/if}
    {:else}
      <p class="text-muted-foreground" data-preview="binary">This file is not text, so it has no preview.</p>
    {/if}
    <Button size="touch" href={downloadUrl(host, instance, session, file, { abs })} download={name}>Download</Button>
  {/if}
</div>
