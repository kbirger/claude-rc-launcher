<script lang="ts">
  import { SshPage } from "#lib/features/ssh";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();

  const target = $derived(page.url.searchParams.get("target"));
  const provisioner = $derived(page.url.searchParams.get("provisioner") === "1");
</script>

<!-- Closing the wizard drops `?target=`, so that the link of a draft target opens it again. -->
<SshPage
  {target}
  {provisioner}
  canAdmin={shell.can("admin")}
  onclose={() => target && goto(resolve("/ssh"), { replaceState: true })}
/>
