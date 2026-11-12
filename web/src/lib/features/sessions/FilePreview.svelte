<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Button } from "#lib/components/ui/button/index.js";
  import { downloadUrl } from "./api";
  import CodeView from "./CodeView.svelte";
  import { baseName, humanSize } from "./format";
  import { TOO_COMPLEX_CUT_NOTE, TOO_COMPLEX_NOTE, formatText } from "./formatted";
  import FormattedText from "./FormattedText.svelte";
  import { previewQuery } from "./queries";
  import { COMPLEX_FALLBACK_LIMIT, showsInPre, viewKind } from "./viewkind";

  // `abs`: `file` is the absolute path of a touched file outside the session folder.
  type Props = { host: string; instance: string; session: string; file: string; abs?: boolean; back: string };
  let { host, instance, session, file, abs = false, back }: Props = $props();

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

<!-- One row of controls above the pane: Rendered and Source (markdown), Wrap (every CodeView) and Download. -->
{#snippet controls(markdown: boolean, showWrap: boolean)}
  <div class="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-2">
    {#if markdown}
      <div role="group" aria-label="Markdown view" class="contents">
        <Button size="touch" variant={rendered ? "default" : "outline"} aria-pressed={rendered} onclick={() => (rendered = true)}>Rendered</Button>
        <Button size="touch" variant={rendered ? "outline" : "default"} aria-pressed={!rendered} onclick={() => (rendered = false)}>Source</Button>
      </div>
    {/if}
    {#if showWrap}
      <Button size="touch" variant={wrap ? "default" : "outline"} aria-pressed={wrap} onclick={() => (wrap = !wrap)}>Wrap</Button>
    {/if}
    {@render download()}
  </div>
{/snippet}

{#snippet download()}
  {#if q.data}
    <Button size="touch" href={downloadUrl(host, instance, session, file, { abs })} download={name}>Download</Button>
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
    <Button class="flex-none" variant="outline" size="touch" href={back}>Back</Button>
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
            {@const cut = f.note === TOO_COMPLEX_NOTE && text.length > COMPLEX_FALLBACK_LIMIT}
            {#if f.note}<p class="text-sm text-muted-foreground">{cut ? TOO_COMPLEX_CUT_NOTE : f.note}</p>{/if}
            {@render plain(cut ? text.slice(0, COMPLEX_FALLBACK_LIMIT) : text, true)}
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
