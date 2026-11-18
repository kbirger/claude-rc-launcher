<script lang="ts">
  import * as Field from "#lib/components/ui/field/index.js";
  import * as RadioGroup from "#lib/components/ui/radio-group/index.js";
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

  // The radio group works with strings, so a value is matched by its text and the node value is sent back unchanged.
  function choose(key: "createSession" | "spawnMode", values: { value: boolean | string }[], text: string) {
    const found = values.find((v) => String(v.value) === text);
    if (found) onchange({ ...value, [key]: found.value } as InstanceSettings);
  }
</script>

<div class="grid min-w-0 gap-4">
  {#each shown as s, n (s.key)}
    <fieldset class="m-0 grid min-w-0 gap-2 border-0 p-0" {disabled}>
      <legend class="mb-1 p-0 text-sm font-medium [overflow-wrap:anywhere]">{s.label}</legend>
      <RadioGroup.Root value={String(value[s.key])} {disabled} aria-label={s.label} onValueChange={(text) => choose(s.key, s.values, text)}>
        {#each s.values as v, k (k)}
          <Field.Label for="{uid}-{n}-{k}">
            <Field.Field orientation="horizontal">
              <Field.Content>
                <Field.Title>{v.label}</Field.Title>
                <Field.Description>{v.explanation}</Field.Description>
              </Field.Content>
              <RadioGroup.Item value={String(v.value)} id="{uid}-{n}-{k}" class="mt-0.5" />
            </Field.Field>
          </Field.Label>
        {/each}
      </RadioGroup.Root>
      {#if s.limits}<p class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.limits}</p>{/if}
    </fieldset>
  {/each}
</div>
