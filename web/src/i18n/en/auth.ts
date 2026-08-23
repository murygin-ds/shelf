/**
 * The four screens a reader meets before the app itself: sign in, sign up, recovery and
 * the invite code.
 *
 * Two things here are not interface. `meter` is what the strength bar says, written by
 * `lib/passphrase.ts` rather than by a component. `kitFile` is the downloadable recovery
 * kit — a whole plain-text document, printed as often as it is filed, and the one piece of
 * text a reader reaches for on their worst day. The layout of that file lives in
 * `crypto/recovery.ts`; only its words are here.
 */

import { countedEn } from '../plural';

export const auth = {
  fields: {
    email: 'Email',
    workEmail: 'Work email',
    name: 'Name',
    passphrase: 'Passphrase',
    newPassphrase: 'New passphrase',
    inviteCode: 'Invite code',
    recoveryCode: 'Recovery code',
  },

  /** Above the notice that explains what the server cannot do. */
  zeroKnowledge: 'Zero-knowledge',

  signIn: {
    title: 'Unlock your vaults',
    lede: 'Your passphrase decrypts locally. The server never receives it.',
    lost: 'Lost it?',
    busy: 'Deriving keys…',
    submit: 'Unlock',
    signOut: 'Sign out',
    createOne: 'Create one',
  },

  signUp: {
    step: (n: number, total: number) => `Step ${n} of ${total}`,
    identifyTitle: 'Create your account',
    identifyLede: 'On this server, run by your team. Export anytime as plain markdown.',
    continue: 'Continue',
    passphraseTitle: 'Set your encryption passphrase',
    passphraseLede: 'This key never leaves your device. It wraps every vault key you hold.',
    warning:
      'If you lose this passphrase, no one — not your admin, not the server — can restore your notes. Save the recovery kit.',
    busy: 'Generating your keys…',
    submit: 'Create account',
    signInLink: 'Sign in',
  },

  recover: {
    identifyTitle: 'Use your recovery kit',
    identifyLede:
      'The code from your kit unwraps your master key on this device. The server checks a separate verifier and never sees the code itself.',
    continue: 'Continue',
    resetTitle: 'Choose a new passphrase',
    resetLede: 'Your notes stay as they are — only the key that wraps your master key changes.',
    notice:
      'Every existing session is signed out, and the recovery code you just used stops working. A new kit is issued on the next screen.',
    busy: 'Re-wrapping your keys…',
    submit: 'Reset passphrase',
    signInLink: 'Sign in',
  },

  join: {
    title: 'Join with a code',
    lede: 'Whoever invited you handed you a code. It never reaches the server — it is what unwraps the vault key on this device.',
    busy: 'Checking…',
    submit: 'Continue',
    /** Stands in for the inviter when the sealed preview carries no name. */
    someone: 'Someone',
    role: 'Your role',
    keys: 'Keys in this invite',
    notice:
      'Accepting unwraps the vault key with this code and re-seals it to your own key on this device. The person who invited you cannot read your key, and the server only ever stores the wrapped copy.',
    lockedNotice:
      'The invite is re-sealed to a key only you hold, so you need one first. The code is kept while you go.',
    unlock: 'Unlock',
    signIn: 'Sign in',
    createAccount: 'Create an account',
    acceptBusy: 'Re-sealing keys…',
    accept: 'Accept & unlock',
    decline: 'Decline',
    back: 'Back to your vaults',
    wrongCode: 'That code does not open anything here.',
    locked: 'Your keys are locked on this device. Unlock them and open this code again.',
    readOnly: 'Read-only mode is on. Turn it off in the account menu to accept this invite.',
  },

  kit: {
    step: 'Recovery kit',
    title: 'Save your recovery kit',
    lede: 'This code is shown once. It is the only way back into your notes if you forget your passphrase.',
    notice:
      'The server holds your master key wrapped with a key derived from this code, and cannot unwrap it. Neither can your administrator.',
    download: 'Download kit',
    downloadAgain: 'Download again',
    copy: 'Copy code',
    confirm: 'I stored this code somewhere safe and offline.',
    open: 'Open Shelf',
  },

  meter: {
    common: 'Contains a very common word.',
    tooShort: (n: number) => `At least ${countedEn(n, ['character', 'characters'])}.`,
    fair: 'Longer is better than more symbols.',
    good: 'Good. A fourth word would make it strong.',
    strong: 'Strong.',
  },

  kitFile: {
    title: 'SHELF RECOVERY KIT',
    server: 'Server',
    account: 'Account',
    name: 'Name',
    key: 'Key',
    issued: 'Issued',
    code: 'RECOVERY CODE',
    body:
      'This code is the only way to reach your notes if you forget your passphrase.\n' +
      'It is not stored anywhere: the server keeps your master key wrapped with a key\n' +
      'derived from this code and cannot unwrap it, and neither can your administrator.',
    offline: 'Keep it offline. Anyone holding it can read everything you can.',
  },
};
