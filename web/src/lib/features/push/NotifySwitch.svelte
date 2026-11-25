<script lang="ts">
  import { Label } from "#lib/components/ui/label/index.js";
  import { onMount } from "svelte";
  import { getKey, subscribe, unsubscribe } from "./api";

  // A switch that makes this browser receive a push notification for each SSH request. It is hidden when the browser
  // cannot do push. The state is the push subscription of the browser: on when one exists and the permission is not
  // denied.
  const supported =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof globalThis.PushManager !== "undefined" &&
    typeof globalThis.Notification !== "undefined";

  let on = $state(false);
  let busy = $state(false);
  let denied = $state(typeof Notification !== "undefined" && Notification.permission === "denied");
  let problem = $state("");

  // The key of the hub is base64url text. The browser wants the bytes.
  function keyBytes(key: string): Uint8Array<ArrayBuffer> {
    const text = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
  }

  const registration = () => navigator.serviceWorker.ready;

  onMount(() => {
    if (!supported) return;
    void registration()
      .then((item) => item.pushManager.getSubscription())
      .then((item) => (on = item !== null && !denied))
      .catch(() => (on = false));
  });

  async function turnOn() {
    if (Notification.permission !== "granted") {
      const answer = await Notification.requestPermission();

      if (answer !== "granted") {
        denied = answer === "denied";
        throw new Error("Notifications are not allowed for this site.");
      }
    }

    const { key } = await getKey();
    const item = await registration();
    const subscription = await item.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    });

    try {
      await subscribe(subscription.toJSON());
    } catch (error) {
      // The hub does not know this subscription, so the browser must not keep it.
      await subscription.unsubscribe().catch(() => false);
      throw error;
    }
  }

  async function turnOff() {
    const item = await registration();
    const subscription = await item.pushManager.getSubscription();
    if (!subscription) return;
    const { endpoint } = subscription;
    // The hub first: when it fails, the browser keeps its subscription and the switch stays on.
    await unsubscribe(endpoint).catch((error: unknown) => {
      // The hub has no record of it: that is the wanted end state.
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    });
    await subscription.unsubscribe();
  }

  async function change(box: HTMLInputElement) {
    const want = box.checked;
    busy = true;
    problem = "";

    try {
      await (want ? turnOn() : turnOff());
      on = want;
    } catch (error) {
      box.checked = on;
      problem = error instanceof Error ? error.message : "The change failed.";
    } finally {
      busy = false;
    }
  }
</script>

{#if supported}
  <section class="grid gap-1 rounded-lg border bg-card p-3">
    <Label class="flex min-h-11 items-center justify-between gap-3">
      <span class="font-medium">Notify this device</span>
      <input
        type="checkbox"
        role="switch"
        class="size-5 shrink-0"
        checked={on}
        disabled={busy || denied}
        onchange={(event) => change(event.currentTarget)}
      />
    </Label>
    <p class="text-sm text-muted-foreground">Get a notification on this device when a node asks for SSH access.</p>
    {#if denied}
      <p class="text-sm text-muted-foreground">
        Notifications are blocked for this site. To turn them on, allow notifications for this site in your browser
        settings, then reload this page.
      </p>
    {/if}
    {#if problem}
      <p role="alert" class="text-sm text-destructive">{problem}</p>
    {/if}
  </section>
{/if}
