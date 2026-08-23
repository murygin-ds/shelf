import { m } from '@/i18n';
import { segment } from '@/lib/archive';

import { base32, group, randomBytes } from './bytes';
import { normalizeRecoveryCode } from './kdf';

/**
 * The recovery code is the only way back into an account: the server holds the master key
 * wrapped with a key derived from this code, and nothing else that can unwrap it.
 *
 * 125 bits, printed as five groups of five Crockford base32 characters.
 */
const CODE_BYTES = 16;
const CODE_CHARS = 25;
const CODE_GROUP = 5;

export function generateRecoveryCode(): string {
  return group(base32(randomBytes(CODE_BYTES), CODE_CHARS), CODE_GROUP);
}

export function isRecoveryCodeShaped(code: string): boolean {
  return normalizeRecoveryCode(code).length === CODE_CHARS;
}

export interface RecoveryKit {
  login: string;
  displayName: string;
  code: string;
  fingerprint: string;
  issuedAt: Date;
  origin: string;
}

/** Where the values start, wide enough for the longest label in either language. */
const LABEL_COLUMN = 14;

/**
 * Plain text on purpose: the kit has to stay readable when it is printed, pasted into a
 * password manager years later, or opened on a machine that has never seen this app.
 *
 * The words come from the dictionary; the rule under the heading and the label column are
 * measured here, so a longer heading in another language still underlines itself.
 */
export function renderRecoveryKit(kit: RecoveryKit): string {
  const t = m.auth.kitFile;
  const row = (label: string, value: string) => `${label.padEnd(LABEL_COLUMN)}${value}`;

  return [
    t.title,
    '='.repeat(t.title.length),
    '',
    row(t.server, kit.origin),
    row(t.account, kit.login),
    row(t.name, kit.displayName),
    row(t.key, kit.fingerprint),
    row(t.issued, kit.issuedAt.toISOString()),
    '',
    t.code,
    '',
    `    ${kit.code}`,
    '',
    t.body,
    '',
    t.offline,
    '',
  ].join('\n');
}

/** Whitespace and the parts of an address that would read as a second extension. */
const SLUG_GAP = /[\s@.]+/g;

/**
 * Names the downloaded file after whoever it belongs to.
 *
 * A latin whitelist erased a Cyrillic login down to nothing and left every Russian reader
 * with the same anonymous file, so the rule is `segment`'s: drop what a file system refuses
 * and keep every script it takes.
 */
export function recoveryKitFilename(login: string): string {
  const named = login.normalize('NFC').trim();
  const slug =
    named === '' ? '' : segment(named).toLowerCase().replace(SLUG_GAP, '-').replace(/^-+|-+$/g, '');

  return `shelf-recovery-kit-${slug || 'account'}.txt`;
}
