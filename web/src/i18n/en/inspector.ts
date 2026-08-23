/**
 * The right-hand column: five panels about the open note, and the strip that switches them.
 *
 * The tab labels carry a constraint the rest of the file does not — five of them share one
 * fixed column, so each is a single word and has to stay one. Section headings and badges
 * are written in ordinary case here and shouted by `--label-transform`, which is off in
 * Russian: capital Cyrillic at 10px is wider than the column and harder to read besides.
 */

import { countedEn, pluralEn } from '../plural';

export const inspector = {
  tabs: {
    outline: 'Outline',
    links: 'Links',
    tags: 'Tags',
    history: 'History',
    share: 'Share',
  },

  outline: {
    section: (count: number) => `Outline · ${count}`,
    locked: 'A note this device holds no key for has no map.',
    empty:
      'No headings yet. Start a line with # and it shows up here, indented under the one above it.',
  },

  links: {
    backlinks: (count: number) => `Backlinks · ${count}`,
    empty: 'Nothing points here yet. Write [[a title]] in another note.',
    hidden: (count: number) =>
      `${countedEn(count, ['more note links', 'more notes link'])} here from somewhere you cannot see. The count is honest; the names are not yours to have.`,
    out: (count: number) => `Links out · ${count}`,
    /** The unmatched titles follow, so this ends on a colon and `unresolvedTail` closes it. */
    unresolved: (count: number) =>
      `${countedEn(count, ['link', 'links'])} in this note ${pluralEn(count, ['matches', 'match'])} nothing you can open:`,
    unresolvedTail: 'Unmatched titles stay on this device — sending them would publish the text.',
  },

  tags: {
    section: (count: number) => `Tags · ${count}`,
    empty: 'No tags yet. They are sealed with the note’s name, so the server never sees them.',
    add: 'Add a tag',
    remove: (tag: string) => `Remove ${tag}`,
    inText: (count: number) => `In the text · ${count}`,
    inTextNote: 'These are written into the note itself. Edit the text to change them.',
  },

  history: {
    section: (count: number) => `Versions · ${count}`,
    empty: 'No saved versions yet.',
    removedAuthor: 'a removed account',
    version: (seq: number) => `Version ${seq}`,
    locked: 'You hold no key for this version.',

    /** What the signature proves, and the three distinct ways it can prove nothing. */
    signatureOk: 'Signature OK',
    signatureBad: 'Signature failed',
    authorUnknown: 'Author unknown',
    unsigned: 'Unsigned',
  },

  share: {
    section: (count: number) => `Public links · ${count}`,
    denied: 'Only somebody who can manage this note may publish it.',
    lede: 'Anyone with the link reads a copy of this note as it is now. The secret lives in the part of the URL a browser never sends, so the server stores a digest and cannot open what it is serving — and the link carries only this note, never the key to the folder it sits in.',
    frozen:
      'Read-only mode is on, so this note cannot be published from here and existing links cannot be revoked.',
    publish: 'Publish this version',
    shownOnce: 'Shown once',
    copy: 'Copy link',
    live: 'Live',
    revoked: 'Revoked',
    expired: 'Expired',
    views: (count: number) => countedEn(count, ['view', 'views']),
    revoke: 'Revoke',
  },
};
