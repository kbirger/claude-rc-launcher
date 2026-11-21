/** Awaits a promise that must reject and returns the error. A promise that resolves fails the test. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("expected the promise to reject, but it resolved");
}

/** Returns the value, or fails the test when it is undefined or null. It replaces the `!` assertion in tests. */
export function defined<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null) throw new Error("expected a value, but it was " + String(value));

  return value;
}
