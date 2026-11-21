/** The Gravatar address for an email: the SHA-256 of the trimmed, lower-case address. `d=404` makes the image fail when there is no avatar, so the page shows the initials. */
export async function gravatarUrl(email: string, size = 64): Promise<string | undefined> {
  // crypto.subtle exists only in a secure context. Without it the page shows the initials.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const hex = [...new Uint8Array(digest)].map((right) => right.toString(16).padStart(2, "0")).join("");
  return `https://www.gravatar.com/avatar/${hex}?s=${size}&d=404`;
}

/** Up to two letters for a user name: the first letters of the first two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
}
