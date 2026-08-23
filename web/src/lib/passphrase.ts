import { m } from '@/i18n';

/**
 * A deliberately crude strength estimate for the four-bar meter in the sign-up flow.
 * It is a nudge, not a gate: the only thing standing between an attacker and the vault
 * is this passphrase, and there is no server-side lockout on a key that never leaves
 * the device.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Matched as substrings, so «пароль» also covers «парольная». */
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
  'пароль',
  'привет',
  'йцукен',
  'админ',
  'любовь',
  'россия',
  'москва',
  'солнышко',
  'полка',
];

/**
 * Lowercase, uppercase, digit, and punctuation or symbol — by Unicode property rather than
 * by latin range. The ranges scored a Cyrillic letter as punctuation and never as a letter,
 * so a Russian passphrase could not reach two classes however it was written. Whitespace
 * deliberately belongs to none of them: a passphrase of several words is already rewarded
 * by the word count, and counting the spaces twice is what the old `[^a-zA-Z0-9]` did.
 */
const CLASSES = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[\p{P}\p{S}]/u];

export interface Strength {
  /** 0..4, matching the number of filled bars. */
  score: number;
  hint: string;
}

export function strength(passphrase: string): Strength {
  // Composed once: «й» typed as a combining pair is one letter to the reader, and would
  // otherwise count as two characters and match none of the classes.
  const text = passphrase.normalize('NFC');

  if (text.length === 0) return { score: 0, hint: '' };

  const lower = text.toLowerCase();

  if (COMMON.some((word) => lower.includes(word))) {
    return { score: 1, hint: m.auth.meter.common };
  }

  if (text.length < MIN_PASSPHRASE_LENGTH) {
    return { score: 1, hint: m.auth.meter.tooShort(MIN_PASSPHRASE_LENGTH) };
  }

  const classes = CLASSES.filter((re) => re.test(text)).length;
  const words = text.trim().split(/\s+/).length;

  // Length carries most of the weight; a four-word passphrase beats a short scrambled one.
  let score = 2;
  if (text.length >= 16 || words >= 3) score = 3;
  if ((text.length >= 20 && classes >= 2) || words >= 4) score = 4;

  const hints: Record<number, string> = {
    2: m.auth.meter.fair,
    3: m.auth.meter.good,
    4: m.auth.meter.strong,
  };

  return { score, hint: hints[score] ?? '' };
}

export function isAcceptable(passphrase: string): boolean {
  return strength(passphrase).score >= 2;
}
