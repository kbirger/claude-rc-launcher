<script lang="ts">
  import * as ToggleGroup from "#lib/components/ui/toggle-group/index.js";
  import { appearance, setMode, setTheme } from "#lib/shared/theme.svelte";
  import { isMode, isTheme, modeApplies, type ThemeName } from "#lib/shared/theme";
  import { cn } from "#lib/utils.js";

  // A small preview of each palette: the page color, the card color and the primary color (the values in src/app.css).
  const palettes: { id: ThemeName; label: string; swatch: [string, string, string] }[] = [
    { id: "default", label: "Default", swatch: ["#f6f6f8", "#ffffff", "#5b4bdb"] },
    { id: "ayu", label: "Ayu", swatch: ["#0d1017", "#141821", "#e6b450"] },
    { id: "tokyonight", label: "Tokyo Night", swatch: ["#1a1b26", "#1f2335", "#7aa2f7"] },
  ];
  const modeFixed = $derived(!modeApplies(appearance.theme));
</script>

<div class="grid gap-3">
  <div role="radiogroup" aria-label="Palette" class="grid grid-cols-3 gap-2">
    {#each palettes as p (p.id)}
      <button
        type="button"
        role="radio"
        aria-checked={appearance.theme === p.id}
        class={cn("flex min-h-11 flex-col gap-1.5 rounded-lg border p-1.5 text-xs transition-colors", appearance.theme === p.id ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40")}
        onclick={() => setTheme(p.id)}
      >
        <span class="flex h-8 w-full gap-1 rounded-md border p-1" style={`background:${p.swatch[0]}`}>
          <span class="flex-1 rounded-sm" style={`background:${p.swatch[1]}`}></span>
          <span class="w-3 rounded-sm" style={`background:${p.swatch[2]}`}></span>
        </span>
        <span class="text-center">{p.label}</span>
      </button>
    {/each}
  </div>
  <div class="grid gap-1">
    <ToggleGroup.Root type="single" variant="outline" class="w-full" aria-label="Light or dark" disabled={modeFixed} value={appearance.mode} onValueChange={(v) => { if (isMode(v)) setMode(v); }}>
      <ToggleGroup.Item value="system" class="h-11 flex-1">System</ToggleGroup.Item>
      <ToggleGroup.Item value="light" class="h-11 flex-1">Light</ToggleGroup.Item>
      <ToggleGroup.Item value="dark" class="h-11 flex-1">Dark</ToggleGroup.Item>
    </ToggleGroup.Root>
    {#if modeFixed}<p class="m-0 text-xs text-muted-foreground">This palette is always dark.</p>{/if}
  </div>
</div>
