/** The shortest passphrase the hub accepts when a passphrase is set. It counts characters (code points). */
export const MIN_PASSPHRASE = 12;

export const longEnough = (text: string): boolean => {
  // The hub decodes the bytes with a decoder that drops a leading byte order mark (U+FEFF), so it is not counted here.
  const plain = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let count = 0;
  for (const _point of plain) count++;
  return count >= MIN_PASSPHRASE;
};

export const TOO_SHORT = `The passphrase needs at least ${MIN_PASSPHRASE} characters.`;
export const PASSPHRASE_NAME = "claude-rc-ssh-passphrase";
