<script lang="ts">
  import * as Field from "#lib/components/ui/field/index.js";
  import * as RadioGroup from "#lib/components/ui/radio-group/index.js";
  import type { InstanceSettings, SettingsHelp } from "./api";

  // Draws each setting of the node help as a choice, with the node explanation under each value. All text comes from the
  // node, and it renders as text. A setting or a value that this page does not know is left out, so it cannot be sent.
  let {
    help,
    value,
    onchange,
    disabled = false,
  }: {
    help: SettingsHelp;
    value: InstanceSettings;
    onchange: (value: InstanceSettings) => void;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();

  const fits = (key: string, candidate: unknown) =>
    key === "spawnMode" ? candidate === "same-dir" || candidate === "worktree" : typeof candidate === "boolean";
  const shown = $derived(
    help.settings
      .filter((setting) => ["createSession", "spawnMode", "sshRequests"].includes(setting.key))
      .map((setting) => ({ ...setting, values: setting.values.filter((option) => fits(setting.key, option.value)) }))
      .filter((setting) => setting.values.length > 0),
  );

  // The radio group works with strings, so a value is matched by its text and the node value is sent back unchanged.
  function choose(
    key: "createSession" | "spawnMode" | "sshRequests",
    values: { value: boolean | string }[],
    text: string,
  ) {
    const found = values.find((option) => String(option.value) === text);
    if (found) onchange({ ...value, [key]: found.value } as InstanceSettings);
  }
</script>

<div class="grid min-w-0 gap-4">
  {#each shown as setting, index (setting.key)}
    <fieldset class="m-0 grid min-w-0 gap-2 border-0 p-0" {disabled}>
      <legend class="mb-1 p-0 text-sm font-medium [overflow-wrap:anywhere]">{setting.label}</legend>
      <RadioGroup.Root
        value={String(value[setting.key] ?? false)}
        {disabled}
        aria-label={setting.label}
        onValueChange={(text) => choose(setting.key, setting.values, text)}
      >
        {#each setting.values as entry, key (key)}
          <Field.Label for="{uid}-{index}-{key}">
            <Field.Field orientation="horizontal">
              <Field.Content>
                <Field.Title>{entry.label}</Field.Title>
                <Field.Description>{entry.explanation}</Field.Description>
              </Field.Content>
              <RadioGroup.Item value={String(entry.value)} id="{uid}-{index}-{key}" class="mt-0.5" />
            </Field.Field>
          </Field.Label>
        {/each}
      </RadioGroup.Root>
      {#if setting.limits}<p class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{setting.limits}</p>{/if}
    </fieldset>
  {/each}
</div>
