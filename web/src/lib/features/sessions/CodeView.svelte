<script lang="ts">
  // A read-only code viewer. CodeMirror builds only the lines in view, so a file of 512 KB opens at once. This file imports
  // CodeMirror only by import(), so the library stays out of every page that shows no code. If the editor cannot load
  // (for example the phone is offline), the text shows in a plain pre box. If only the language cannot load, the editor
  // shows without colors.
  import { onMount } from "svelte";
  import type { Editor } from "./editor";
  import { loadLanguage } from "./languages";
  import type { LanguageId } from "./viewkind";

  type Props = { text: string; language?: LanguageId; wrap?: boolean; lineNumbers?: boolean };
  let { text, language, wrap = true, lineNumbers = false }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let editor: Editor | undefined = $state.raw();
  let failed = $state(false);

  onMount(() => {
    let gone = false;
    let made: Editor | undefined;
    import("./editor").then(
      ({ createEditor }) => {
        if (gone || !host) return;
        made = createEditor(host, { text, wrap, lineNumbers });
        editor = made;
      },
      () => {
        if (!gone) failed = true;
      },
    );
    return () => {
      gone = true;
      editor = undefined;
      made?.destroy();
    };
  });

  $effect(() => {
    const e = editor;
    if (!e) return;
    e.setText(text);
    e.setWrap(wrap);
    e.setLineNumbers(lineNumbers);
  });

  // The language loads on its own, so a slow or failed language never holds back the text.
  $effect(() => {
    const e = editor;
    const id = language;
    if (!e) return;
    let stale = false;
    (id ? loadLanguage(id) : Promise.resolve(undefined)).then(
      (ext) => { if (!stale) e.setLanguage(ext); },
      () => { if (!stale) e.setLanguage(undefined); },
    );
    return () => { stale = true; };
  });
</script>

{#if failed}
  <pre class="m-0 overflow-auto rounded-lg border bg-card p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
{:else}
  <div bind:this={host} class="code-view min-w-0 max-w-full rounded-lg border bg-card"></div>
{/if}
