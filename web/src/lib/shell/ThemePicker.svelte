<script lang="ts">
  import * as Field from "#lib/components/ui/field/index.js";
  import * as RadioGroup from "#lib/components/ui/radio-group/index.js";
  import * as ToggleGroup from "#lib/components/ui/toggle-group/index.js";
  import { appearance, setMode, setTheme } from "#lib/shared/theme.svelte";
  import { isMode, isTheme, type ThemeName } from "#lib/shared/theme";

  const uid = $props.id();

  // A small preview of each palette in its light and its dark variant: the page color, the card color and the primary color (the values in src/app.css).
  type Swatch = [string, string, string];
  const palettes: { id: ThemeName; label: string; light: Swatch; dark: Swatch }[] = [
    { id: "default", label: "Default", light: ["#f6f6f8", "#ffffff", "#5b4bdb"], dark: ["#121216", "#1d1d23", "#8a7dff"] },
    { id: "claude", label: "Claude", light: ["#ffffff", "#f4f2f1", "#c2410c"], dark: ["#0c0a09", "#1c1917", "#9a3412"] },
    { id: "ayu", label: "Ayu", light: ["#f8f9fa", "#fcfcfc", "#925808"], dark: ["#0d1017", "#141821", "#e6b450"] },
    { id: "tokyonight", label: "Tokyo Night", light: ["#e6e7ed", "#f3f4f8", "#2959aa"], dark: ["#1a1b26", "#1f2335", "#7aa2f7"] },
  ];
</script>

<div class="grid gap-3">
  <RadioGroup.Root value={appearance.theme} aria-label="Palette" class="grid-cols-2 sm:grid-cols-4" onValueChange={(v) => { if (isTheme(v)) setTheme(v); }}>
    {#each palettes as p (p.id)}
      {@const swatch = appearance.dark ? p.dark : p.light}
      <Field.Label for="{uid}-{p.id}" class="min-h-11">
        <Field.Field orientation="horizontal" class="items-start">
          <Field.Content class="gap-1.5">
            <span class="flex h-8 w-full gap-1 rounded-md border p-1" style={`background:${swatch[0]}`}>
              <span class="flex-1 rounded-sm" style={`background:${swatch[1]}`}></span>
              <span class="w-3 rounded-sm" style={`background:${swatch[2]}`}></span>
            </span>
            <Field.Title>{p.label}</Field.Title>
          </Field.Content>
          <RadioGroup.Item value={p.id} id="{uid}-{p.id}" class="mt-0.5" />
        </Field.Field>
      </Field.Label>
    {/each}
  </RadioGroup.Root>
  <div class="grid gap-1">
    <ToggleGroup.Root type="single" variant="outline" class="w-full" aria-label="Light or dark" value={appearance.mode} onValueChange={(v) => { if (isMode(v)) setMode(v); }}>
      <ToggleGroup.Item value="system" class="h-11 flex-1">System</ToggleGroup.Item>
      <ToggleGroup.Item value="light" class="h-11 flex-1">Light</ToggleGroup.Item>
      <ToggleGroup.Item value="dark" class="h-11 flex-1">Dark</ToggleGroup.Item>
    </ToggleGroup.Root>
  </div>
</div>
