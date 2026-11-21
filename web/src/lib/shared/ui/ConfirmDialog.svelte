<script lang="ts" module>
  export type Ask = { title: string; body: string; label: string; destructive?: boolean; run: () => void };
</script>

<script lang="ts">
  import * as AlertDialog from "#lib/components/ui/alert-dialog/index.js";

  // The confirmation step of an action. The caller sets `ask` and the dialog opens. The caller sets it to null, or the user answers, and the dialog closes.
  let { ask = $bindable(null) }: { ask: Ask | null } = $props();
  // The last question stays in view while the dialog fades out.
  let last = $state<Ask | null>(null);
  $effect(() => {
    if (ask) last = ask;
  });

  function confirm() {
    const request = ask;
    ask = null;
    request?.run();
  }
</script>

<AlertDialog.Root
  open={ask !== null}
  onOpenChange={(open) => {
    if (!open) ask = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{last?.title}</AlertDialog.Title>
      <AlertDialog.Description>{last?.body}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel size="touch">Cancel</AlertDialog.Cancel>
      <AlertDialog.Action size="touch" variant={last?.destructive ? "destructive" : "default"} onclick={confirm}>
        {last?.label}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
