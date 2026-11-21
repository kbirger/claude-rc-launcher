// Runs `fn` inside an effect root, so models that make effects and queries can run in a test. Returns what `fn`
// returned and a `dispose` that stops the effects. Rune calls are only legal in .svelte.ts files, hence this helper.
export function inRoot<Value>(fn: () => Value): { value: Value; dispose: () => void } {
  let value!: Value;
  const dispose = $effect.root(() => {
    value = fn();
  });
  return { value, dispose };
}

// A deeply reactive copy of `o`, so a test can change what a model reads through a getter and its effects rerun.
export function reactive<Value extends object>(value: Value): Value {
  const entry = $state(value);
  return entry;
}
