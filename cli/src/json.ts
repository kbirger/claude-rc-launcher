/** True for a JSON object (not an array and not null), so that its members can be read as unknown values. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a response body as JSON. Fetch types the result as `any`; this returns it as `unknown`, to be checked before use. */
export async function readJson(res: Response): Promise<unknown> {
  return res.json();
}
