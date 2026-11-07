<script lang="ts">
  import { onMount } from "svelte";
  import { getMe, type Me } from "./lib/api";
  import InstanceList from "./lib/InstanceList.svelte";
  import NewDialog from "./lib/NewDialog.svelte";

  let me = $state<Me | null>(null);
  let showNew = $state(false);
  let refreshKey = $state(0);

  onMount(() => {
    getMe().then((m) => (me = m)).catch(() => {});
  });
</script>

<header>
  <h1>Claude RC</h1>
  <span class="user">{me?.name ?? ""}</span>
  <a class="logout" href={me?.logoutUrl ?? "/auth/logout"}>Logout</a>
</header>
<main>
  <button class="primary new" onclick={() => (showNew = true)}>+ New</button>
  <InstanceList host="local" {refreshKey} />
</main>
{#if showNew}
  <NewDialog
    host="local"
    onclose={() => (showNew = false)}
    onstarted={() => {
      showNew = false;
      refreshKey++;
    }}
  />
{/if}

<style>
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  h1 { font-size: 1.1rem; margin: 0; flex: 1; }
  .user { color: var(--muted); font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logout { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; color: var(--accent); }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .new { width: 100%; margin-bottom: 16px; }
</style>
