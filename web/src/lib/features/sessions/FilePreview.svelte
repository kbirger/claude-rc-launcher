<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Code from "@tabler/icons-svelte/icons/code";
  import Download from "@tabler/icons-svelte/icons/download";
  import Eye from "@tabler/icons-svelte/icons/eye";
  import TextWrap from "@tabler/icons-svelte/icons/text-wrap";
  import ArrowLeft from "@tabler/icons-svelte/icons/arrow-left";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Toggle } from "#lib/components/ui/toggle/index.js";
  import * as ToggleGroup from "#lib/components/ui/toggle-group/index.js";
  import { downloadUrl } from "./api";
  import CodeView from "./CodeView.svelte";
  import { baseName, humanSize } from "./format";
  import { formatText } from "./formatted";
  import FormattedText from "./FormattedText.svelte";
  import { previewQuery } from "./queries";
  import { showsInPre, viewKind } from "./viewkind";

  // `abs`: `file` is the absolute path of a touched file outside the session folder.
  type Props = { host: string; instance: string; session: string; file: string; abs?: boolean; back: string; backLabel?: string };
  let { host, instance, session, file, abs = false, back, backLabel = "Back" }: Props = $props();

  const q = createQuery(() => previewQuery(host, instance, session, file, abs));
  const name = $derived(baseName(file));
  // Markdown opens rendered. Code and large plain text open wrapped, as the plain view always did.
  let rendered = $state(true);
  let wrap = $state(true);

  // The preview pane fills the screen below the controls and scrolls inside itself, so the page never gets a scroll bar of
  // its own. --pane-top is the distance from the top of the page to the pane. --pane-max is what is left of the screen
  // under it, less the room of the fixed bottom navigation (the same 6.5rem that the page column keeps free). In a very low
  // window (a phone on its side) the pane keeps 150 px and the page scrolls instead.
  let anchor: HTMLElement | undefined = $state.raw();
  let paneTop = $state(0);
  function track(node: HTMLElement) {
    anchor = node;
    return { destroy() { if (anchor === node) anchor = undefined; } };
  }
  $effect(() => {
    const node = anchor;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = Math.round(node.getBoundingClientRect().top + window.scrollY);
      if (top !== paneTop) paneTop = top;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    // The rows above the pane change height when a banner shows or the window turns. Measuring after the frame avoids a resize loop.
    const watcher = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    watcher?.observe(document.body);
    window.addEventListener("resize", schedule);
    return () => {
      watcher?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  });
  const PANE = "min-w-0 max-h-[var(--pane-max)] overflow-auto overscroll-contain";
</script>

<!-- One small row of controls above the pane: Rendered or Source (markdown), a Wrap switch (every CodeView) and Download. -->
{#snippet controls(markdown: boolean, showWrap: boolean)}
  <div class="flex flex-wrap items-center gap-2">
    {#if markdown}
      <ToggleGroup.Root type="single" variant="outline" size="sm" aria-label="Markdown view" value={rendered ? "rendered" : "source"} onValueChange={(v) => { if (v) rendered = v === "rendered"; }}>
        <ToggleGroup.Item value="rendered" class="px-2.5"><Eye aria-hidden="true" />Rendered</ToggleGroup.Item>
        <ToggleGroup.Item value="source" class="px-2.5"><Code aria-hidden="true" />Source</ToggleGroup.Item>
      </ToggleGroup.Root>
    {/if}
    <div class="ml-auto flex items-center gap-2">
      {#if showWrap}
        <Toggle variant="outline" size="sm" bind:pressed={wrap} aria-label="Wrap long lines" title="Wrap long lines"><TextWrap aria-hidden="true" />Wrap</Toggle>
      {/if}
      {@render download()}
    </div>
  </div>
{/snippet}

{#snippet download()}
  {#if q.data}
    <Button size="sm" variant="outline" class="border-primary/40 text-primary hover:bg-primary/10 hover:text-primary" href={downloadUrl(host, instance, session, file, { abs })} download={name}><Download aria-hidden="true" />Download</Button>
  {/if}
{/snippet}

<!-- Plain text. A short text with no long line is a pre box. Any other text is a CodeView with no language, so a 512 KB file does not make a giant page and a long line does not make a slow layout. A markdown file that could not be formatted always uses CodeView: a pre box lays out a long unbroken line slowly. -->
{#snippet plain(text: string, code: boolean = false)}
  {#if !code && showsInPre(text)}
    {@render controls(false, false)}
    <pre use:track data-preview="plain" class="{PANE} m-0 rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
  {:else}
    {@render controls(false, true)}
    <div use:track data-preview="plain" class="min-w-0"><CodeView {text} {wrap} /></div>
  {/if}
{/snippet}

<div class="grid gap-3" style="--pane-max: max(150px, calc(100dvh - {paneTop}px - 6.5rem - env(safe-area-inset-bottom) - 1px))">
  <!-- One row: Back, then the name and the size. The room above the pane is what the pane does not get. -->
  <div class="flex items-center gap-3">
    <Button class="flex-none text-muted-foreground hover:border-border" variant="ghost" size="sm" href={back}><ArrowLeft aria-hidden="true" />{backLabel}</Button>
    {#if q.data}
      {@const p = q.data}
      <div class="grid min-w-0 gap-0.5">
        <div class="font-semibold [overflow-wrap:anywhere]">{p.name}</div>
        {#if abs}
          <div class="text-sm text-muted-foreground [overflow-wrap:anywhere]">{file}</div>
          <div class="text-sm text-muted-foreground">outside the session folder</div>
        {/if}
        <div class="text-sm text-muted-foreground">{humanSize(p.size)}</div>
      </div>
    {/if}
  </div>
  {#if q.isPending}
    <p class="text-muted-foreground">Loading file...</p>
  {:else if q.error}
    <p class="error">{q.error.message}</p>
  {:else if q.data}
    {@const p = q.data}
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
            {@render controls(true, !rendered)}
            {#if rendered}
              <div use:track data-preview="rendered" class="{PANE} rounded-lg border bg-card p-3"><FormattedText html={f.html} /></div>
            {:else}
              <div use:track data-preview="source" class="min-w-0"><CodeView {text} language="markdown" {wrap} /></div>
            {/if}
          {:else}
            {#if f.note}<p class="text-sm text-muted-foreground">{f.note}</p>{/if}
            {@render plain(text, true)}
          {/if}
        {/await}
      {:else if plan.kind === "code"}
        {@render controls(false, true)}
        <div use:track data-preview="code" class="min-w-0"><CodeView {text} language={plan.language} {wrap} /></div>
      {:else}
        {#if plan.note}<p class="text-sm text-muted-foreground">{plan.note}</p>{/if}
        {@render plain(text)}
      {/if}
    {:else}
      <p class="text-muted-foreground" data-preview="binary">This file is not text, so it has no preview.</p>
      {@render controls(false, false)}
    {/if}
  {/if}
</div>
