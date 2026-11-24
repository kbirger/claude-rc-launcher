/** The shortest passphrase the hub accepts when a passphrase is set. It counts characters (code points). */
export const MIN_PASSPHRASE = 12;

export const longEnough = (text: string): boolean => {
  let count = 0;
  for (const point of text) count += point.length > 0 ? 1 : 0;
  return count >= MIN_PASSPHRASE;
};

export const TOO_SHORT = `The passphrase needs at least ${MIN_PASSPHRASE} characters.`;
export const PASSPHRASE_NAME = "claude-rc-ssh-passphrase";
