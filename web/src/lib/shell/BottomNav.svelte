<script lang="ts">
  import { page } from "$app/state";
  import Server from "@tabler/icons-svelte/icons/server";
  import Home from "@tabler/icons-svelte/icons/home";
  import LayoutGrid from "@tabler/icons-svelte/icons/layout-grid";
  import { cn } from "#lib/utils.js";
  import MenuSheet from "./MenuSheet.svelte";

  let menuOpen = $state(false);
  const left = [
    { href: "/nodes", label: "Nodes", icon: Server },
  ];
  const right = [{ href: "/instances", label: "Instances", icon: Home }];
  const link = (active: boolean) =>
    cn("flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-xs transition-colors", active ? "text-primary" : "text-muted-foreground hover:text-foreground");
</script>

{#snippet item(it: { href: string; label: string; icon: typeof Server })}
  <a href={it.href} class={link(page.url.pathname === it.href)} aria-current={page.url.pathname === it.href ? "page" : undefined}>
    <it.icon size={22} aria-hidden="true" />{it.label}
  </a>
{/snippet}

<!-- Fixed to the bottom of the screen, above the page (z-40) and below the sheet and the New dialog (z-50). -->
<nav aria-label="Main" class="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
  <div class="flex w-full max-w-md items-center gap-1 rounded-2xl border bg-card/90 p-1.5 shadow-lg backdrop-blur">
    {#each left as it (it.href)}
      {@render item(it)}
    {/each}
    <button
      type="button"
      class="flex size-14 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-95"
      aria-label="Menu"
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      onclick={() => (menuOpen = true)}
    >
      <LayoutGrid size={28} aria-hidden="true" />
    </button>
    {#each right as it (it.href)}
      {@render item(it)}
    {/each}
  </div>
</nav>
<MenuSheet bind:open={menuOpen} />
