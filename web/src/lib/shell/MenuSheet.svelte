<script lang="ts">
  import { page } from "$app/state";
  import Home from "@tabler/icons-svelte/icons/home";
  import Messages from "@tabler/icons-svelte/icons/messages";
  import Server from "@tabler/icons-svelte/icons/server";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";
  import Palette from "@tabler/icons-svelte/icons/palette";
  import Key from "@tabler/icons-svelte/icons/key";
  import Github from "@tabler/icons-svelte/icons/brand-github-filled";
  import LogOut from "@tabler/icons-svelte/icons/logout";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { resolve } from "$app/paths";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { grantsQuery, statusQuery } from "#lib/features/ssh";
  import { createQuery } from "@tanstack/svelte-query";
  import Avatar from "./Avatar.svelte";
  import { getShell } from "./context";
  import { REPO_URL } from "./links";

  let { open = $bindable(false) }: { open: boolean } = $props();
  const shell = getShell();
  // The update history is part of Updates (the "All history" link there), so it is not a menu item. It lights up Updates.
  const sshItem = { href: resolve("/ssh"), label: "SSH access", icon: Key, also: undefined };
  const items = [
    { href: resolve("/sessions"), label: "Sessions", icon: Messages, also: undefined },
    { href: resolve("/instances"), label: "Instances", icon: Home },
    { href: resolve("/nodes"), label: "Nodes", icon: Server },
    { href: resolve("/updates"), label: "Updates", icon: ArrowUp, also: resolve("/history") },
    { href: resolve("/appearance"), label: "Appearance", icon: Palette },
  ];
  // Only an admin sets up and approves SSH access. The hub refuses everyone else anyway: this hides what would be refused.
  const isAdmin = $derived(shell.can("admin"));
  const shown = $derived(isAdmin ? [...items, sshItem] : items);
  // The badge on SSH access counts the requests that wait for the owner. The menu is on every page, so the reads are
  // light: the status is read once in a while, and the grants only for an admin when SSH is set up. TanStack stops the
  // 15 second timer in a hidden tab.
  const SSH_STATUS_STALE_MS = 300_000;
  const SSH_BADGE_POLL_MS = 15_000;
  const status = createQuery(() => ({
    ...statusQuery(),
    staleTime: SSH_STATUS_STALE_MS,
    refetchOnWindowFocus: false,
    enabled: isAdmin,
  }));
  const grants = createQuery(() => ({
    ...grantsQuery(),
    refetchInterval: SSH_BADGE_POLL_MS,
    enabled: isAdmin && status.data?.setUp === true,
  }));
  const pending = $derived(grants.data?.filter((grant) => grant.state === "pending").length ?? 0);
</script>

<Sheet.Root bind:open>
  <Sheet.Content
    side="bottom"
    class="mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]"
  >
    <Sheet.Header>
      <Sheet.Title class="flex items-center gap-2">
        {#if shell.user}<Avatar name={shell.user} email={shell.email} /><span>
            {shell.user}{#if shell.role}<span class="ml-1.5 font-normal text-muted-foreground">
                · {shell.role}
              </span>{/if}
          </span>{:else}Menu{/if}
      </Sheet.Title>
      <Sheet.Description class="sr-only">Pages and links.</Sheet.Description>
    </Sheet.Header>
    <nav class="grid gap-1 px-4" aria-label="Menu">
      {#each shown as it (it.href)}
        <Button
          variant={page.url.pathname === it.href || page.url.pathname === it.also ? "secondary" : "ghost"}
          size="touch"
          class="justify-start"
          href={it.href}
          onclick={() => (open = false)}
        >
          <it.icon size={20} aria-hidden="true" />{it.label}
          {#if it === sshItem && pending > 0}
            <Badge data-pending-grants class="ml-auto" aria-label="{pending} pending requests">{pending}</Badge>
          {/if}
        </Button>
      {/each}
      <Button
        variant="ghost"
        size="touch"
        class="justify-start"
        externalHref={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Github size={20} aria-hidden="true" />GitHub
      </Button>
      <Button variant="ghost" size="touch" class="justify-start" externalHref={shell.logoutUrl}>
        <LogOut size={20} aria-hidden="true" />Log out
      </Button>
    </nav>
  </Sheet.Content>
</Sheet.Root>
