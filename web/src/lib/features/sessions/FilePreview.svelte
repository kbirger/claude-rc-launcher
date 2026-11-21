<script lang="ts">
  import type { ResolvedPathname } from "$app/types";
  import * as Alert from "#lib/components/ui/alert/index.js";
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
  type Props = {
    host: string;
    instance: string;
    session: string;
    file: string;
    abs?: boolean;
    back: ResolvedPathname;
    backLabel?: string;
  };
  let { host, instance, session, file, abs = false, back, backLabel = "Back" }: Props = $props();

  const query = createQuery(() => previewQuery(host, instance, session, file, abs));
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
    return {
      destroy() {
        if (anchor === node) anchor = undefined;
      },
    };
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

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

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

<!-- One small row of controls above the pane, all as tall as each other: Rendered or Source (markdown) with the Wrap switch next to it, and Download on the right. -->
{#snippet controls(markdown: boolean, showWrap: boolean)}
  <div class="flex flex-wrap items-center gap-2">
    {#if markdown}
      <ToggleGroup.Root
        type="single"
        variant="outline"
        size="default"
        aria-label="Markdown view"
        value={rendered ? "rendered" : "source"}
        onValueChange={(value) => {
          if (value) rendered = value === "rendered";
        }}
      >
        <ToggleGroup.Item value="rendered" class="h-8 px-2.5"><Eye aria-hidden="true" />Rendered</ToggleGroup.Item>
        <ToggleGroup.Item value="source" class="h-8 px-2.5"><Code aria-hidden="true" />Source</ToggleGroup.Item>
      </ToggleGroup.Root>
    {/if}
    {#if showWrap}
      <Toggle
        variant="outline"
        class="h-8 px-2.5"
        bind:pressed={wrap}
        aria-label="Wrap long lines"
        title="Wrap long lines"
      >
        <TextWrap aria-hidden="true" />Wrap
      </Toggle>
    {/if}
    <div class="ml-auto">{@render download()}</div>
  </div>
{/snippet}

{#snippet download()}
  {#if query.data}
    <Button
      variant="outline"
      class="h-8 border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
      externalHref={downloadUrl(host, instance, session, file, { abs })}
      download={name}
    >
      <Download aria-hidden="true" />Download
    </Button>
  {/if}
{/snippet}

<!-- Plain text. A short text with no long line is a pre box. Any other text is a CodeView with no language, so a 512 KB file does not make a giant page and a long line does not make a slow layout. A markdown file that could not be formatted always uses CodeView: a pre box lays out a long unbroken line slowly. -->
{#snippet plain(text: string, code: boolean = false)}
  {#if !code && showsInPre(text)}
    {@render controls(false, false)}
    <pre
      use:track
      data-preview="plain"
      class="{PANE} rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
  {:else}
    {@render controls(false, true)}
    <div use:track data-preview="plain" class="min-w-0"><CodeView {text} {wrap} /></div>
  {/if}
{/snippet}

<div
  class="grid gap-3"
  style="--pane-max: max(150px, calc(100dvh - {paneTop}px - 6.5rem - env(safe-area-inset-bottom) - 1px))"
>
  <!-- Back on a row of its own, then the name and the size under it. -->
  <Button class="-ml-2 h-8 w-fit px-2 text-muted-foreground" variant="ghost" size="sm" href={back}>
    <ArrowLeft aria-hidden="true" />{backLabel}
  </Button>
  {#if query.data}
    {@const preview = query.data}
    <div class="grid min-w-0 gap-0.5">
      <div class="font-semibold [overflow-wrap:anywhere]">{preview.name}</div>
      {#if abs}
        <div class="text-sm text-muted-foreground [overflow-wrap:anywhere]">{file}</div>
        <div class="text-sm text-muted-foreground">outside the session folder</div>
      {/if}
      <div class="text-sm text-muted-foreground">{humanSize(preview.size)}</div>
    </div>
  {/if}
  {#if query.isPending}
    <p class="text-muted-foreground">Loading file...</p>
  {:else if query.error}
    <Alert.Root variant="destructive"><Alert.Description>{query.error.message}</Alert.Description></Alert.Root>
  {:else if query.data}
    {@const preview = query.data}
    {#if preview.kind === "text"}
      {#if preview.truncated}
        <p class="text-sm text-warning">
          Showing only the start of {humanSize(preview.size)}. Download the file for the rest.
        </p>
      {/if}
      {@const text = preview.text ?? ""}
      {@const plan = viewKind(preview.name, text.length)}
      {#if plan.kind === "markdown"}
        {#await formatText(preview.name, text)}
          <p class="text-muted-foreground">Rendering...</p>
        {:then result}
          {#if result.kind === "markdown"}
            {@render controls(true, !rendered)}
            {#if rendered}
              <div use:track data-preview="rendered" class="{PANE} rounded-lg border bg-card p-3">
                <FormattedText html={result.html} />
              </div>
            {:else}
              <div use:track data-preview="source" class="min-w-0"><CodeView {text} language="markdown" {wrap} /></div>
            {/if}
          {:else}
            {#if result.note}<p class="text-sm text-muted-foreground">{result.note}</p>{/if}
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
