<script lang="ts">
  import { onMount } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import IconRefresh from "@tabler/icons-svelte/icons/refresh";
  import { canStartPull, pullDistance, shouldRefresh, THRESHOLD } from "./pullrefresh";

  const client = useQueryClient();
  let pull = $state(0);
  let busy = $state(false);

  // The browser's own pull-to-refresh is off (overscroll-behavior in app.css). This one refetches the data on screen
  // and leaves the page loaded. "me" never changes, so it stays out.
  async function refresh() {
    busy = true;
    pull = THRESHOLD;

    try {
      await Promise.all([
        client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "me" }),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    } finally {
      busy = false;
      pull = 0;
    }
  }

  onMount(() => {
    let startY: number | null = null;

    const start = (touchEvent: TouchEvent) => {
      startY =
        !busy && touchEvent.touches.length === 1 && canStartPull(touchEvent.target, window.scrollY)
          ? touchEvent.touches[0].clientY
          : null;
    };

    const move = (touchEvent: TouchEvent) => {
      if (startY === null) return;
      if (window.scrollY > 0) return void ((startY = null), (pull = 0));
      pull = pullDistance(touchEvent.touches[0].clientY - startY);
    };

    const end = () => {
      if (startY === null) return;
      startY = null;
      if (shouldRefresh(pull)) void refresh();
      else pull = 0;
    };

    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);

    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  });
</script>

{#if pull > 0}
  <div
    class="ptr"
    style:transform="translateY({pull}px)"
    role="status"
    aria-label={busy ? "Refreshing" : "Pull to refresh"}
  >
    <span class:spin={busy} style:rotate={busy ? undefined : `${(pull / THRESHOLD) * 270}deg`}>
      <IconRefresh size={20} aria-hidden="true" />
    </span>
  </div>
{/if}

<style>
  /* Sits just under the sticky header and slides down with the pull. */
  .ptr {
    position: fixed;
    top: 52px;
    left: 50%;
    z-index: 30;
    width: 36px;
    height: 36px;
    margin: -36px 0 0 -18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--card);
    color: var(--primary);
    border: 1px solid var(--border);
    border-radius: 50%;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.2);
    pointer-events: none;
  }
  .spin {
    display: inline-flex;
    animation: ptr-spin 0.8s linear infinite;
  }
  @keyframes ptr-spin {
    to {
      rotate: 360deg;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>
