// A test helper: props that a mounted component sees change. `$state` works only in .svelte.ts files, so tests get it here.
export function reactiveProps<T extends object>(initial: T): T {
  const props = $state(initial);
  return props;
}
