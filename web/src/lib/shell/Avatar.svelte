<script lang="ts">
  import { gravatarUrl, initials } from "./avatar";

  let { name, email, size = 32 }: { name: string; email?: string; size?: number } = $props();
  let src = $state<string>();
  let failed = $state(false);

  // The image address comes from a hash, so it is computed after the email is known. A failed load (no Gravatar) shows the initials.
  $effect(() => {
    failed = false;
    src = undefined;
    if (!email) return;
    let live = true;
    gravatarUrl(email, size * 2).then(
      (url) => {
        if (live) src = url;
      },
      () => {},
    );

    return () => {
      live = false;
    };
  });
</script>

<span
  class="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground"
  style="width:{size}px;height:{size}px"
  aria-hidden="true"
>
  {initials(name)}
  {#if src && !failed}<img
      class="absolute inset-0 size-full object-cover"
      {src}
      alt=""
      referrerpolicy="no-referrer"
      onerror={() => (failed = true)}
    />{/if}
</span>
