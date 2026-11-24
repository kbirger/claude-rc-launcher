<script lang="ts">
  import { SshPage } from "#lib/features/ssh";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  const target = $derived(page.url.searchParams.get("target"));
</script>

<!-- Closing the wizard drops `?target=`, so that the link of a draft target opens it again. -->
<SshPage {target} onclose={() => target && goto(resolve("/ssh"), { replaceState: true })} />
