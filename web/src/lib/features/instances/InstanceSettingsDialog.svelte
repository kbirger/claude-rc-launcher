<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { Instance, SettingsHelp } from "./api";
  import InstanceSettingsFields from "./InstanceSettingsFields.svelte";
  import { createSettingsDialogModel } from "./model.svelte";

  // Changes the settings of one instance after the user presses Apply. Mount it fresh for each open: it reads `instance` once.
  let {
    open = $bindable(false),
    host,
    instance,
    help,
  }: { open: boolean; host: string; instance: Instance; help: SettingsHelp } = $props();

  const model = createSettingsDialogModel({
    host: untrack(() => host),
    client: useQueryClient(),
    instance: untrack(() => instance),
    onclose: () => (open = false),
  });
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<!-- While a change runs, the dialog stays open: a close by Escape or a tap outside does nothing. -->
<Sheet.Root
  bind:open={
    () => open,
    (value) => {
      if (value || !model.busy) open = value;
    }
  }
>
  <Sheet.Content
    side="bottom"
    class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]"
  >
    <Sheet.Header>
      <Sheet.Title class={wrap}>Settings of {instance.name}</Sheet.Title>
      <Sheet.Description class="sr-only">Choose the settings, then press Apply.</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      <InstanceSettingsFields {help} value={model.value} onchange={(value) => model.set(value)} disabled={model.busy} />
      <Alert.Root role="note">
        <Alert.Description class={wrap}>
          If this folder runs, applying this restarts its server. If Create a session at start is on, its sessions come
          back. If this folder is paused, the change is only saved.
        </Alert.Description>
      </Alert.Root>
      {#if model.busy}<Alert.Root role="status">
          <Alert.Description class={wrap}>
            If this folder runs, its server restarts with the new settings. This can take up to a minute.
          </Alert.Description>
        </Alert.Root>{/if}
      {#if model.notice}<Alert.Root role="status">
          <Alert.Description class={wrap}>{model.notice}</Alert.Description>
        </Alert.Root>{/if}
      {#if model.error}<Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{model.error}</Alert.Description>
        </Alert.Root>{/if}
    </div>
    <Sheet.Footer class="px-4">
      <Button type="button" size="touch" disabled={model.busy || !model.changed} onclick={() => model.apply()}>
        {model.busy ? "Applying..." : "Apply"}
      </Button>
      <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={() => (open = false)}>
        Cancel
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
