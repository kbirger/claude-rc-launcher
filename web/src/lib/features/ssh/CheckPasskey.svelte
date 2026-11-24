<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { toBase64Url, UnlockError, unlockWithPasskey, PRF_MISSING } from "./prf";

  let { credentialId, busy = false }: { credentialId: string; busy?: boolean } = $props();

  const HINT = "If the phone showed no passkey to pick, wait a few seconds and try again.";
  let running = $state(false);
  let result = $state<{ ok: boolean; text: string; hint: boolean } | null>(null);

  // One unlock on a random salt, in the tap itself. Nothing goes to the hub. Only the presence of the secret counts,
  // so the value is dropped at once.
  async function check() {
    if (running) return;
    running = true;
    result = null;

    try {
      // unlockWithPasskey throws when no secret comes back, so a return means success. The value is discarded.
      await unlockWithPasskey(credentialId, toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
      result = { ok: true, text: "Your passkey returned a PRF secret. It works.", hint: false };
    } catch (error) {
      const text = error instanceof UnlockError ? error.message : "The passkey check failed";
      result = { ok: false, text, hint: text !== PRF_MISSING };
    } finally {
      running = false;
    }
  }
</script>

<div class="mt-2">
  <Button variant="outline" size="touch" disabled={running || busy} onclick={check}>
    {running ? "Checking..." : "Check my passkey"}
  </Button>
  <p class="mt-2 text-sm" aria-live="polite">
    {#if result}
      {result.text}
      {#if result.hint}{HINT}{/if}
    {/if}
  </p>
</div>
