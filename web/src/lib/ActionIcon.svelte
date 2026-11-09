<script lang="ts">
  export type ActionIconName = "up" | "new-folder" | "clone";

  let { name }: { name: ActionIconName } = $props();

  // Outline icons on a 16x16 grid. They are drawn with strokes, so currentColor and the disabled style apply to them.
  const paths: Record<ActionIconName, string> = {
    up: "M8 13.5V3M3.5 7.5 8 3l4.5 4.5",
    "new-folder": "M1.5 3.5h4l1.25 1.5h7.75v7.5h-13ZM8 7.25v3.5M6.25 9h3.5",
    clone: "M8 2.5V10M4.75 6.75 8 10l3.25-3.25M2.5 13h11",
  };
</script>

<svg viewBox="0 0 16 16" width="1.25em" height="1.25em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>

<style>
  svg { display: block; }
</style>
