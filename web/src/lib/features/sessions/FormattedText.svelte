<script lang="ts">
  // The only place in the app that inserts raw HTML. `html` has the type SafeHtml, which only sanitizeMarkdownHtml in
  // sanitize.ts can make. rawhtml.test.ts fails if any other file inserts raw HTML, or if this file does it twice. Code
  // never comes here: CodeView.svelte writes text nodes.
  import type { SafeHtml } from "./sanitize";
  import "./formatted.css";

  type Props = { html: SafeHtml };
  let { html }: Props = $props();
</script>

<div class="formatted-md">{@html html}</div>
