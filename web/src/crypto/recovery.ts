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

/**
 * Plain text on purpose: the kit has to stay readable when it is printed, pasted into a
 * password manager years later, or opened on a machine that has never seen this app.
 */
export function renderRecoveryKit(kit: RecoveryKit): string {
  return [
    'SHELF RECOVERY KIT',
    '==================',
    '',
    `Server        ${kit.origin}`,
    `Account       ${kit.login}`,
    `Name          ${kit.displayName}`,
    `Key           ${kit.fingerprint}`,
    `Issued        ${kit.issuedAt.toISOString()}`,
    '',
    'RECOVERY CODE',
    '',
    `    ${kit.code}`,
    '',
    'This code is the only way to reach your notes if you forget your passphrase.',
    'It is not stored anywhere: the server keeps your master key wrapped with a key',
    'derived from this code and cannot unwrap it, and neither can your administrator.',
    '',
    'Keep it offline. Anyone holding it can read everything you can.',
    '',
  ].join('\n');
}

export function recoveryKitFilename(login: string): string {
  const slug = login.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

  return `shelf-recovery-kit-${slug || 'account'}.txt`;
}
