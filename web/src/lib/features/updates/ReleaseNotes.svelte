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
  const query = createQuery(() => ({
    ...releaseNotesQuery(range?.from ?? "", range?.to ?? ""),
    enabled: range !== undefined,
  }));
  const ready = $derived(query.data?.complete ? query.data.releases : undefined);
  // A complete answer with no releases has nothing to show (a version that could not be read, a dev build), so it gets the same line and link.
  const unavailable = $derived(
    query.isError || (query.data !== undefined && (!query.data.complete || query.data.releases.length === 0)),
  );

  // The release text is untrusted. It only reaches the page through renderMarkdown and FormattedText. The markdown chunk loads when the first body needs it.
  // `undefined` means that the guard refused the body, so it shows as plain text. `null` means that it is not rendered yet.
  let rendered = $state<Record<string, SafeHtml | undefined | null>>({});
  $effect(() => {
    const releases = ready;
    if (!releases) return;
    const todo = releases.filter((release) => release.body.trim() && !(release.version in rendered));
    if (todo.length === 0) return;
    let live = true;
    import("../sessions/markdown").then(
      ({ renderMarkdown }) => {
        if (!live) return;
        const next = { ...rendered };

        // One body that cannot be rendered falls back to plain text. The others still render.
        for (const release of todo) {
          try {
            next[release.version] = renderMarkdown(release.body);
          } catch {
            next[release.version] = undefined;
          }
        }

        rendered = next;
      },
      () => {
        // The chunk did not load (offline, or a stale chunk after a hub update): every body shows as plain text.
        if (!live) return;
        const next = { ...rendered };
        for (const release of todo) next[release.version] = undefined;
        rendered = next;
      },
    );

    return () => {
      live = false;
    };
  });
  const date = (iso: string): string => (Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleDateString());
</script>

{#if range}
  {#if unavailable}
    <section class="mt-3 grid gap-1">
      <h3 class="font-heading text-sm font-semibold">What changed</h3>
      <p class="text-xs text-muted-foreground">
        The notes are not available. <a
          class="text-primary underline-offset-4 hover:underline"
          href={releasePageUrl(range.to)}
          target="_blank"
          rel="noreferrer external"
        >
          Open the release page.
        </a>
      </p>
    </section>
  {:else if ready}
    <section class="mt-3 grid gap-3">
      <h3 class="font-heading text-sm font-semibold">What changed</h3>
      {#each ready as release (release.version)}
        <div data-release={release.version} class="grid gap-1">
          <h4 class="font-heading text-sm font-semibold">
            {release.version}
            <time class="font-normal text-muted-foreground" datetime={release.publishedAt}>
              {date(release.publishedAt)}
            </time>
          </h4>
          {#if !release.body.trim()}
            <p class="text-xs text-muted-foreground">No notes.</p>
          {:else if release.version in rendered && rendered[release.version]}
            <FormattedText html={rendered[release.version]!} />
          {:else if release.version in rendered}
            <pre class="text-xs break-all whitespace-pre-wrap">{release.body}</pre>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
{/if}
