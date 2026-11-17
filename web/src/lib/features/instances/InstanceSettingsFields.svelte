<script lang="ts">
  import type { InstanceSettings, SettingsHelp } from "./api";

  // Draws each setting of the node help as a choice, with the node explanation under each value. All text comes from the
  // node, and it renders as text. A setting or a value that this page does not know is left out, so it cannot be sent.
  let { help, value, onchange, disabled = false }: { help: SettingsHelp; value: InstanceSettings; onchange: (v: InstanceSettings) => void; disabled?: boolean } = $props();

  const uid = $props.id();

  const fits = (key: string, v: unknown) => (key === "createSession" ? typeof v === "boolean" : v === "same-dir" || v === "worktree");
  const shown = $derived(
    help.settings
      .filter((s) => s.key === "createSession" || s.key === "spawnMode")
      .map((s) => ({ ...s, values: s.values.filter((v) => fits(s.key, v.value)) }))
      .filter((s) => s.values.length > 0),
  );

  function choose(key: "createSession" | "spawnMode", v: boolean | string) {
    onchange({ ...value, [key]: v } as InstanceSettings);
  }
</script>

<div class="grid min-w-0 gap-4">
  {#each shown as s, n (s.key)}
    <fieldset class="m-0 grid min-w-0 gap-2 border-0 p-0" {disabled}>
      <legend class="mb-1 p-0 text-sm font-medium [overflow-wrap:anywhere]">{s.label}</legend>
      {#each s.values as v, k (k)}
        <div class="grid gap-0.5">
          <label class="flex min-h-11 items-center gap-3 text-sm [overflow-wrap:anywhere]">
            <input
              type="radio"
              name="{uid}-{n}"
              class="size-5 w-auto shrink-0 accent-primary"
              checked={value[s.key] === v.value}
              aria-describedby="{uid}-{n}-{k}"
              onchange={() => choose(s.key, v.value)}
            />{v.label}
          </label>
          <p id="{uid}-{n}-{k}" class="m-0 pl-8 text-xs text-muted-foreground [overflow-wrap:anywhere]">{v.explanation}</p>
        </div>
      {/each}
      {#if s.limits}<p class="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.limits}</p>{/if}
    </fieldset>
  {/each}
</div>
