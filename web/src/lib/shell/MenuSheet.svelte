<script lang="ts">
  import { page } from "$app/state";
  import Home from "@tabler/icons-svelte/icons/home";
  import Server from "@tabler/icons-svelte/icons/server";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";
  import Palette from "@tabler/icons-svelte/icons/palette";
  import Github from "@tabler/icons-svelte/icons/brand-github-filled";
  import LogOut from "@tabler/icons-svelte/icons/logout";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { getShell } from "./context";
  import { REPO_URL } from "./links";

  let { open = $bindable(false) }: { open: boolean } = $props();
  const shell = getShell();
  // The update history is part of Updates (the "All history" link there), so it is not a menu item. It lights up Updates.
  const items = [
    { href: "/instances", label: "Instances", icon: Home },
    { href: "/nodes", label: "Nodes", icon: Server },
    { href: "/updates", label: "Updates", icon: ArrowUp, also: "/history" },
    { href: "/appearance", label: "Appearance", icon: Palette },
  ];
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="bottom" class="mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]">
    <Sheet.Header>
      <Sheet.Title>Menu</Sheet.Title>
      <Sheet.Description class="sr-only">Pages and links.</Sheet.Description>
    </Sheet.Header>
    <nav class="grid gap-1 px-4" aria-label="Menu">
      {#each items as it (it.href)}
        <Button variant={page.url.pathname === it.href || page.url.pathname === it.also ? "secondary" : "ghost"} size="touch" class="justify-start" href={it.href} onclick={() => (open = false)}>
          <it.icon size={20} aria-hidden="true" />{it.label}
        </Button>
      {/each}
      <Button variant="ghost" size="touch" class="justify-start" href={REPO_URL} target="_blank" rel="noopener noreferrer">
        <Github size={20} aria-hidden="true" />GitHub
      </Button>
      <Button variant="ghost" size="touch" class="justify-start" href={shell.logoutUrl}>
        <LogOut size={20} aria-hidden="true" />Log out{shell.user ? ` (${shell.user})` : ""}
      </Button>
    </nav>
  </Sheet.Content>
</Sheet.Root>
