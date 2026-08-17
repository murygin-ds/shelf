import { Facet } from '@codemirror/state';

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
}

export interface VaultContext {
  notes: readonly NoteRef[];
  /** The same titles, lower-cased, so resolution is a lookup rather than a scan. */
  titles: ReadonlySet<string>;
  tags: readonly string[];
}

export const EMPTY_CONTEXT: VaultContext = { notes: [], titles: new Set(), tags: [] };

export const vaultContext = Facet.define<VaultContext, VaultContext>({
  combine: (values) => values[0] ?? EMPTY_CONTEXT,
});

export function contextOf(notes: readonly NoteRef[], tags: readonly string[]): VaultContext {
  return {
    notes,
    titles: new Set(notes.map((note) => note.name.trim().toLowerCase())),
    tags,
  };
}
