<script lang="ts">
  import { page } from "$app/state";
  import Home from "@tabler/icons-svelte/icons/home";
  import Server from "@tabler/icons-svelte/icons/server";
  import History from "@tabler/icons-svelte/icons/history";
  import Github from "@tabler/icons-svelte/icons/brand-github-filled";
  import LogOut from "@tabler/icons-svelte/icons/logout";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Separator } from "#lib/components/ui/separator/index.js";
  import { getShell } from "./context";
  import { REPO_URL } from "./links";
  import ThemePicker from "./ThemePicker.svelte";

  let { open = $bindable(false) }: { open: boolean } = $props();
  const shell = getShell();
  const items = [
    { href: "/", label: "Instances", icon: Home },
    { href: "/nodes", label: "Nodes", icon: Server },
    { href: "/history", label: "Update history", icon: History },
  ];
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="bottom" class="max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]">
    <Sheet.Header>
      <Sheet.Title>Menu</Sheet.Title>
      <Sheet.Description class="sr-only">Pages, links and the theme.</Sheet.Description>
    </Sheet.Header>
    <nav class="grid gap-1 px-4" aria-label="Menu">
      {#each items as it (it.href)}
        <Button variant={page.url.pathname === it.href ? "secondary" : "ghost"} size="touch" class="justify-start" href={it.href} onclick={() => (open = false)}>
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
    <Separator />
    <div class="px-4"><ThemePicker /></div>
  </Sheet.Content>
</Sheet.Root>
