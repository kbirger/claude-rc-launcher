<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { Instance, SettingsHelp } from "./api";
  import InstanceSettingsFields from "./InstanceSettingsFields.svelte";
  import { createSettingsDialogModel } from "./model.svelte";

  // Changes the settings of one instance after the user presses Apply. Mount it fresh for each open: it reads `instance` once.
  let { open = $bindable(false), host, instance, help }: { open: boolean; host: string; instance: Instance; help: SettingsHelp } = $props();

  const model = createSettingsDialogModel({
    host: untrack(() => host),
    client: useQueryClient(),
    instance: untrack(() => instance),
    onclose: () => (open = false),
  });
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<!-- While a change runs, the dialog stays open: a close by Escape or a tap outside does nothing. -->
<Sheet.Root bind:open={() => open, (v) => { if (v || !model.busy) open = v; }}>
  <Sheet.Content side="bottom" class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]">
    <Sheet.Header>
      <Sheet.Title class={wrap}>Settings of {instance.name}</Sheet.Title>
      <Sheet.Description class="sr-only">Choose the settings, then press Apply.</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      <InstanceSettingsFields {help} value={model.value} onchange={(v) => model.set(v)} disabled={model.busy} />
      <p class="m-0 text-sm {wrap}" role="note">Applying this restarts the server of this folder. If Create a session at start is on, its sessions come back.</p>
      {#if model.busy}<p class="m-0 text-sm text-muted-foreground {wrap}" role="status">The server restarts with the new settings. This can take up to a minute.</p>{/if}
      {#if model.error}<p class="m-0 text-sm text-destructive {wrap}" role="alert">{model.error}</p>{/if}
    </div>
    <Sheet.Footer class="px-4">
      <Button type="button" size="touch" disabled={model.busy || !model.changed} onclick={() => model.apply()}>{model.busy ? "Applying..." : "Apply"}</Button>
      <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={() => (open = false)}>Cancel</Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
