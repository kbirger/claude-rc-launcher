<script lang="ts">
  import { Label } from "#lib/components/ui/label/index.js";
  import { onMount } from "svelte";
  import { createPushSubscriptionModel } from "./subscription.svelte";

  // A switch that makes this browser receive a push notification for each SSH request. It is hidden when the browser
  // cannot do push. The subscription model holds the state and the permission flow.
  const model = createPushSubscriptionModel();

  onMount(() => void model.sync());

  async function change(box: HTMLInputElement) {
    // A failed change puts the box back to the state that stays.
    box.checked = await model.change(box.checked);
  }
</script>

{#if model.supported}
  <section class="grid gap-1 rounded-lg border bg-card p-3">
    <Label class="flex min-h-11 items-center justify-between gap-3">
      <span class="font-medium">Notify this device</span>
      <input
        type="checkbox"
        role="switch"
        class="size-5 shrink-0"
        checked={model.on}
        disabled={model.busy || model.denied}
        onchange={(event) => change(event.currentTarget)}
      />
    </Label>
    <p class="text-sm text-muted-foreground">Get a notification on this device when a node asks for SSH access.</p>
    {#if model.denied}
      <p class="text-sm text-muted-foreground">
        Notifications are blocked for this site. To turn them on, allow notifications for this site in your browser
        settings, then reload this page.
      </p>
    {/if}
    {#if model.problem}
      <p role="alert" class="text-sm text-destructive">{model.problem}</p>
    {/if}
  </section>
{/if}
