/**
 * The four full-window views: search, the graph, the trash and the account.
 *
 * Three of them end on a paragraph that has two mutually exclusive versions — the graph
 * draws locked notes or it does not, the trash is writable or it is not — and only one is
 * ever on screen. Both are written out rather than assembled from a shared stem, because
 * the version nobody looked at is exactly the one that stays in English.
 *
 * Headings and badges are in ordinary case here and shouted by `--label-transform`.
 */

import { countedEn } from '../plural';

export const views = {
  search: {
    placeholder: 'Search this vault',
    results: (count: number) => countedEn(count, ['result', 'results']),
    indexed: (count: number) => `${count} indexed`,
    allNotes: 'All notes',
    tag: (name: string) => `tag: #${name}`,
    local: 'Searched locally on the decrypted index — no query leaves this device',
    /** Sits next to `local` and qualifies it, so it opens on the separator. */
    downloading: (covered: number, total: number) =>
      `· index ${covered}/${total} — still downloading`,
    none: 'Nothing matched.',
    noneYet: 'Nothing matched. The index is still filling in — try again in a moment.',
  },

  graph: {
    title: 'Graph',
    /** The accessible name of the drawing itself, read instead of the nodes. */
    canvas: 'Note graph',
    drawing: 'Drawing the graph…',
    empty: 'No notes yet. Links appear here once notes reference each other with [[a title]].',
    legend: (notes: number, links: number) =>
      `${countedEn(notes, ['note', 'notes'])} · ${countedEn(links, ['link', 'links'])}`,
    legendLocked: (notes: number, links: number, locked: number) =>
      `${countedEn(notes, ['note', 'notes'])} · ${countedEn(links, ['link', 'links'])} · ${locked} locked`,
    node: (name: string, links: number) => `${name} · ${countedEn(links, ['link', 'links'])}`,
    revealsLocked:
      'Dashed nodes are notes you hold no key for. They are drawn without a name or an id, because a graph that hid them would show connected notes as isolated.',
    hidesLocked:
      'This vault does not draw notes you cannot open, so the picture is your slice of the graph rather than its shape.',
  },

  trash: {
    title: 'Trash',
    items: (count: number) => countedEn(count, ['item', 'items']),
    empty:
      'Nothing deleted. Items land here when you remove them, still encrypted, until you either put them back or destroy them for good.',
    noKey: 'No key',
    folder: 'Folder',
    note: 'Note',
    restore: 'Restore',
    /** Two presses, and the second has to sound heavier than the first. */
    purge: 'Delete forever',
    purgeArmed: 'Destroy for good',
    frozen:
      'Read-only mode is on: this is the list and nothing more. Turn it off in the account menu to restore anything or destroy it for good.',
    footer:
      'Restoring a folder brings back what was inside it. Deleting forever destroys the ciphertext — there is no copy anywhere that could bring it back, here or on the server.',
  },

  profile: {
    title: 'Profile',
    back: 'Back to notes',

    account: 'Account',
    interface: 'Interface',
    keys: 'Keys',
    passphrase: 'Passphrase',
    danger: 'Danger zone',

    login: 'Login',
    memberSince: 'Member since',
    vaults: 'Vaults',
    vaultsOwn: (owned: number) => `${owned} own`,
    vaultsShared: (owned: number, shared: number) => `${owned} own · ${shared} shared with you`,

    thisDevice: 'This device',
    keyUnlocked: 'Key unlocked',
    keyLocked: 'Key locked',
    fingerprint: 'Key fingerprint',
    keyNote:
      'Your passphrase never leaves this device: it unwraps the master key here, and the server only ever holds the wrapped copy.',
    lock: 'Lock keys',
    signOut: 'Sign out',

    displayName: 'Display name',
    nameFailed: 'Could not save the name.',

    language: 'Language',
    languageNote:
      'The language is picked once, as the app loads, so switching reloads the page. Anything typed is saved before it does.',

    currentPassphrase: 'Current passphrase',
    newPassphrase: 'New passphrase',
    repeatPassphrase: 'Repeat new passphrase',
    passphraseNote: (min: number) =>
      `At least ${countedEn(min, ['character', 'characters'])}. Your other devices are signed out, and a new recovery code is issued and shown once — the old one stops working.`,
    mismatch: 'The two do not match.',
    reused: 'That is the passphrase you already have.',
    changing: 'Changing…',
    change: 'Change passphrase',
    passphraseFailed: 'Could not change the passphrase.',

    dangerTitle: 'Delete this account',
    dangerBody:
      'Your account, the vaults you own and everything in them go with it, for every member of those vaults. There is no trash behind this and no key that brings it back.',
    deleteAccount: 'Delete account',
    deleteTitle: 'Delete your account?',
    deleteBody:
      'This destroys your account, every vault you own and everything in them, for all of their members. The server keeps only ciphertext and deletes it; no key anyone kept will bring it back. Notes you wrote in somebody else’s vault stay with that vault.',
    confirmPassphrase: 'Confirm with your passphrase',
    deleting: 'Deleting…',
    deleteFailed: 'Could not delete the account.',
  },
};
