<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import BlockedList from "./BlockedList.svelte";
  import RuleList from "./RuleList.svelte";
  import { isUnsupported } from "./api";
  import { blockedQuery, sessionPermissionsQuery } from "./queries";

  type View = "permissions" | "blocked";
  // `view` is the selected tab. The page owns it (the address follows it), so a click is passed up.
  let {
    host,
    instance,
    session,
    view,
    now,
    live,
    onpick,
  }: {
    host: string;
    instance: string;
    session: string;
    view: View;
    now: number;
    live?: boolean;
    onpick: (value: View) => void;
  } = $props();

  const rules = createQuery(() => sessionPermissionsQuery(host, instance, session));
  // The same query as BlockedList: one request, shared.
  const blocked = createQuery(() => blockedQuery(host, instance, session));
  const help = {
    permissions:
      "The permission rules that apply to this session, from every settings file. A deny rule wins over an ask rule, and an ask rule wins over an allow rule.",
    blocked: "Tool calls that Claude Code blocked in this session. A rule that allows the call can fix most of them.",
  };
  const pick = (value: string) => {
    if (value === "permissions" || value === "blocked") onpick(value);
  };
</script>

<h3 class="font-heading text-sm font-semibold">Permissions</h3>
<Tabs.Root value={view} onValueChange={pick}>
  <Tabs.List aria-label="Session permissions" class="group-data-horizontal/tabs:h-auto w-full">
    <Tabs.Trigger value="permissions" class="h-11 text-sm">Rules</Tabs.Trigger>
    <Tabs.Trigger value="blocked" class="h-11 text-sm">
      Blocked{#if blocked.data?.length}<Badge variant="secondary" class="ml-1.5">{blocked.data.length}</Badge>{/if}
    </Tabs.Trigger>
  </Tabs.List>
  <p class="mt-2 mb-3 text-xs text-muted-foreground">{help[view]}</p>
  <Tabs.Content value={view} class="min-w-0">
    {#if view === "blocked"}
      <BlockedList {host} {instance} {session} {now} {live} layers={rules.data?.layers} />
    {:else if rules.isPending}
      <p class="text-muted-foreground">Loading permissions...</p>
    {:else if isUnsupported(rules.error)}
      <p class="text-muted-foreground">This node does not support permissions. Update the node.</p>
    {:else if rules.error}
      <Alert.Root variant="destructive">
        <Alert.Description>Could not load the permissions: {rules.error.message}</Alert.Description>
      </Alert.Root>
    {:else if rules.data}
      <RuleList layers={rules.data.layers} {host} {instance} {session} />
    {/if}
  </Tabs.Content>
</Tabs.Root>
