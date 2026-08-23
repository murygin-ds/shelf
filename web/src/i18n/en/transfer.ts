/**
 * Carrying a vault out as a zip and reading one back in.
 *
 * The skip report is the shape worth explaining. It used to be built from parts — a count,
 * a noun, a preposition — and that only works while the noun never changes. Russian puts
 * the thing skipped into whichever case the reason governs: «для 2 заметок нет ключа», but
 * «2 заметки не удалось открыть». So a reason owns its whole phrase, counts and all, and
 * the caller only joins the phrases.
 *
 * The table is keyed by `SkipReason`, which is a closed union: a new reason stops the build
 * here rather than falling through to a bare key on the screen.
 */

import type { SkipReason } from '@/lib/archive';

import { countedEn } from '../plural';

/** «1 folder and 2 notes», with whichever half is actually there. */
function pair(folders: number, notes: number): string {
  return [
    ...(folders > 0 ? [countedEn(folders, ['folder', 'folders'])] : []),
    ...(notes > 0 ? [countedEn(notes, ['note', 'notes'])] : []),
  ].join(' and ');
}

const NOTES = ['note', 'notes'] as const;
const FOLDERS = ['folder', 'folders'] as const;

export const transfer = {
  /** A name for what arrived without one — in the tree, and in a path inside the archive. */
  untitled: 'Untitled',

  leftOut: (what: string) => `Left out: ${what}.`,

  skipped: {
    locked: (folders: number, notes: number) => `${pair(folders, notes)} you hold no key for`,
    'no-key': (folders: number, notes: number) => `${pair(folders, notes)} that would not open`,
    missing: (folders: number, notes: number) =>
      `${pair(folders, notes)} that were not in the archive`,
    'too-large': (folders: number, notes: number) =>
      `${pair(folders, notes)} too large to write`,
    'too-deep': (folders: number, notes: number) =>
      `${pair(folders, notes)} nested deeper than Shelf allows`,
    orphaned: (folders: number, notes: number) =>
      `${pair(folders, notes)} whose folder was not in the archive`,
  } satisfies Record<SkipReason, (folders: number, notes: number) => string>,

  exporting: {
    title: 'Export vault',
    subtitle: (vault: string, notes: number, folders: number) =>
      `${vault} · ${countedEn(notes, NOTES)} · ${countedEn(folders, FOLDERS)}`,
    noVault: 'No vault open',

    /** Reads after the file name, which is the one thing worth spotting in the sentence. */
    wrote: (notes: number, folders: number) =>
      `— ${countedEn(notes, NOTES)} and ${countedEn(folders, FOLDERS)} written.`,
    keepItSafe:
      'The file on your disk is plain text. Keep it somewhere you would keep the notes ' +
      'themselves, or delete it once you have what you needed.',

    warnLead: 'This archive is not encrypted.',
    warnBody:
      'Every note leaves this device as markdown anybody holding the file can read. Shelf’s ' +
      'protection ends at the download; where you keep the file is the only protection it ' +
      'has left.',

    section: 'What goes in',
    asMarkdown: (notes: number) =>
      `${countedEn(notes, NOTES)} as markdown, in the folders you see in the sidebar.`,
    manifest:
      '— the file that records names, icons and tags exactly, so the archive can be ' +
      'imported back.',
    noTrash: 'Items in the trash are not included.',
    noKey: (folders: number, notes: number) =>
      `Whatever you hold no key for stays out: ${pair(folders, notes)}.`,

    reading: (done: number, total: number) => `Reading bodies ${done}/${total}`,
    footerNote: 'The archive is not encrypted',
    busy: 'Exporting…',
    run: 'Export',
  },

  importing: {
    title: 'Import a vault',
    subtitle: 'From an archive Shelf wrote',

    /** Reads after the new vault's name. */
    filled: (notes: number, folders: number) =>
      `— now ${countedEn(notes, NOTES)} in ${countedEn(folders, FOLDERS)}.`,
    failed: (folders: number, notes: number, why: string) =>
      `${pair(folders, notes)} could not be written: ${why} The vault was kept as it stands — ` +
      'delete it from the vault menu if you would rather start again.',

    cannotCarry: 'What an archive cannot carry',
    noHistory: 'Revision history, and the signatures on it.',
    noMembers: 'Members, permissions and keys: this vault is yours alone.',
    noScopes: 'Folders that had a key of their own — everything here is under the vault key.',

    ledeLead: 'This creates a new vault.',
    ledeBody: 'Nothing in the vaults you already have is read or changed.',

    another: 'Choose a different archive',
    choose: 'Choose an archive',
    dropHint: 'or drop a .zip here',

    summary: (notes: number, folders: number) =>
      `${countedEn(notes, NOTES)} · ${countedEn(folders, FOLDERS)}`,
    exportedOn: (at: string) => `exported ${at}`,

    nameLabel: 'Name the new vault',
    keepOpen: 'Keep this tab open',

    footerDone: 'The archive on your disk is still plain text',
    footerNew: 'A new vault, keyed here',
    busy: 'Importing…',
    run: 'Create vault',
  },
};
