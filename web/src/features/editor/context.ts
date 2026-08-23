import { Facet } from '@codemirror/state';

import { linkTargets } from '@/lib/wikilinks';

/**
 * What the editor needs to know about the vault around it.
 *
 * A facet rather than a read of the store: whether `[[Title]]` resolves decides how it is
 * drawn, and a decoration may only change in response to a transaction. Reaching into the
 * store from inside the plugin would leave a renamed note looking unresolved until the next
 * keystroke — and would drag the store, the API client and IndexedDB into a test that today
 * needs nothing but CodeMirror.
 */

export interface NoteRef {
  id: number;
  name: string;
  /** The note's full path, which is what tells two notes of the same name apart. */
  path?: string;
}

export interface VaultContext {
  notes: readonly NoteRef[];
  /** Titles and paths, folded, so resolution is a lookup rather than a scan. */
  targets: ReadonlyMap<string, number>;
  tags: readonly string[];
}

export const EMPTY_CONTEXT: VaultContext = { notes: [], targets: new Map(), tags: [] };

export const vaultContext = Facet.define<VaultContext, VaultContext>({
  combine: (values) => values[0] ?? EMPTY_CONTEXT,
});

export type LinkWhere = 'here' | 'tab';

export type LinkOpener = (target: string, where: LinkWhere) => void;

/**
 * Who opens a `[[link]]` the reader clicked inside a rendered table.
 *
 * Everywhere else the click reaches the editor's own handlers and the component above deals
 * with it. A table is a widget, and a widget that ignores events keeps them to itself — so
 * the one thing inside it that leads somewhere needs a way back out.
 */
export const openWikilink = Facet.define<LinkOpener, LinkOpener | null>({
  combine: (values) => values[0] ?? null,
});

export function contextOf(notes: readonly NoteRef[], tags: readonly string[]): VaultContext {
  return { notes, targets: linkTargets(notes), tags };
}
