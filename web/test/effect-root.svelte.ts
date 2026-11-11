// Runs `fn` inside an effect root, so models that make effects and queries can run in a test. Returns what `fn`
// returned and a `dispose` that stops the effects. Rune calls are only legal in .svelte.ts files, hence this helper.
export function inRoot<T>(fn: () => T): { value: T; dispose: () => void } {
  let value!: T;
  const dispose = $effect.root(() => {
    value = fn();
  });
  return { value, dispose };
}
