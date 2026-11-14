<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import FormattedText from "../sessions/FormattedText.svelte";
  import type { SafeHtml } from "../sessions/sanitize";
  import { releaseNotesQuery } from "./queries";
  import { notesRange, releasePageUrl } from "./releasenotes";
  import type { UpdateEntry } from "./api";

  let { entry }: { entry: UpdateEntry } = $props();

  const range = $derived(notesRange(entry));
  // A failed or running entry has no range, so the query stays off and the section shows nothing.
  const q = createQuery(() => ({ ...releaseNotesQuery(range?.from ?? "", range?.to ?? ""), enabled: range !== undefined }));
  const ready = $derived(q.data?.complete ? q.data.releases : undefined);
  const unavailable = $derived(q.isError || (q.data !== undefined && !q.data.complete));

  // The release text is untrusted. It only reaches the page through renderMarkdown and FormattedText. The markdown chunk loads when the first body needs it.
  // `undefined` means that the guard refused the body, so it shows as plain text. `null` means that it is not rendered yet.
  let rendered = $state<Record<string, SafeHtml | undefined | null>>({});
  $effect(() => {
    const releases = ready;
    if (!releases) return;
    const todo = releases.filter((r) => r.body.trim() && !(r.version in rendered));
    if (todo.length === 0) return;
    let live = true;
    import("../sessions/markdown").then(({ renderMarkdown }) => {
      if (!live) return;
      const next = { ...rendered };
      for (const r of todo) next[r.version] = renderMarkdown(r.body);
      rendered = next;
    });
    return () => { live = false; };
  });
  const date = (iso: string): string => (Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleDateString());
</script>

{#if range}
  {#if unavailable}
    <section class="mt-3 grid gap-1">
      <h3 class="m-0 text-sm font-semibold">What changed</h3>
      <p class="m-0 text-xs text-muted-foreground">The notes are not available. <a class="text-primary underline-offset-4 hover:underline" href={releasePageUrl(range.to)} target="_blank" rel="noreferrer">Open the release page.</a></p>
    </section>
  {:else if ready}
    <section class="mt-3 grid gap-3">
      <h3 class="m-0 text-sm font-semibold">What changed</h3>
      {#each ready as r (r.version)}
        <div data-release={r.version} class="grid gap-1">
          <h4 class="m-0 text-sm font-semibold">{r.version} <time class="font-normal text-muted-foreground" datetime={r.publishedAt}>{date(r.publishedAt)}</time></h4>
          {#if !r.body.trim()}
            <p class="m-0 text-xs text-muted-foreground">No notes.</p>
          {:else if r.version in rendered && rendered[r.version]}
            <FormattedText html={rendered[r.version]!} />
          {:else if r.version in rendered}
            <pre class="m-0 text-xs break-all whitespace-pre-wrap">{r.body}</pre>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
{/if}
