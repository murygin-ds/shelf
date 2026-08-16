/**
 * A deliberately crude strength estimate for the four-bar meter in the sign-up flow.
 * It is a nudge, not a gate: the only thing standing between an attacker and the vault
 * is this passphrase, and there is no server-side lockout on a key that never leaves
 * the device.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

const COMMON = [
  'password',
  'passphrase',
  'qwerty',
  '123456',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'shelf',
  'basalt',
];

export interface Strength {
  /** 0..4, matching the number of filled bars. */
  score: number;
  hint: string;
}

export function strength(passphrase: string): Strength {
  if (passphrase.length === 0) return { score: 0, hint: '' };

  const lower = passphrase.toLowerCase();

  if (COMMON.some((word) => lower.includes(word))) {
    return { score: 1, hint: 'Contains a very common word.' };
  }

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return { score: 1, hint: `At least ${MIN_PASSPHRASE_LENGTH} characters.` };
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(passphrase)).length;
  const words = passphrase.trim().split(/\s+/).length;

  // Length carries most of the weight; a four-word passphrase beats a short scrambled one.
  let score = 2;
  if (passphrase.length >= 16 || words >= 3) score = 3;
  if ((passphrase.length >= 20 && classes >= 2) || words >= 4) score = 4;

  const hints: Record<number, string> = {
    2: 'Longer is better than more symbols.',
    3: 'Good. A fourth word would make it strong.',
    4: 'Strong.',
  };

  return { score, hint: hints[score] ?? '' };
}

export function isAcceptable(passphrase: string): boolean {
  return strength(passphrase).score >= 2;
}
