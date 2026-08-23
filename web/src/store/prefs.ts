import { create } from 'zustand';

/**
 * What this browser prefers, as opposed to what the account is allowed.
 *
 * Nothing here is a secret and nothing here is sealed: it is written in the clear to
 * localStorage, survives a reload and a lock, and says nothing to the server. A preference
 * that decided anything the server enforces would belong in the vault instead.
 */

const READ_ONLY_KEY = 'shelf.read-only';
const GRAPH_ORPHANS_KEY = 'shelf.graph-orphans';

interface PrefsState {
  /**
   * No vault may be written from this device while it is on — not the note on screen, not
   * the tree, not the members list, and not the queue of bodies written offline.
   *
   * It is a promise about this browser rather than a permission: the account keeps every
   * role it had, so another tab, another device or the server itself are unaffected. That
   * is also why it is not a substitute for `view` access — a reader who must not write is
   * given the permission, not asked to turn a switch on.
   */
  readOnly: boolean;
  setReadOnly: (readOnly: boolean) => void;
  /**
   * Whether the graph draws notes nothing links to.
   *
   * Off by default, and the one setting here that is about legibility rather than about
   * what this browser may do: the server returns every note in the vault as a node, so in
   * an ordinary vault the linked structure is a few dozen dots inside a cloud of hundreds
   * of loose ones. The legend always says how many are being left out.
   */
  graphOrphans: boolean;
  setGraphOrphans: (graphOrphans: boolean) => void;
}

export const usePrefs = create<PrefsState>((set) => ({
  readOnly: stored(READ_ONLY_KEY),
  setReadOnly: (readOnly) => {
    remember(READ_ONLY_KEY, readOnly);
    set({ readOnly });
  },
  graphOrphans: stored(GRAPH_ORPHANS_KEY),
  setGraphOrphans: (graphOrphans) => {
    remember(GRAPH_ORPHANS_KEY, graphOrphans);
    set({ graphOrphans });
  },
}));

/**
 * The same answer outside React.
 *
 * The workspace store asks it inside each action rather than trusting the components to
 * hide the verb: a menu item nobody remembered to hide, a keyboard shortcut and a stale
 * timer all reach the store, and none of them may write.
 */
export function isReadOnly(): boolean {
  return usePrefs.getState().readOnly;
}

function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Private mode, storage switched off, or a test with no DOM. Off is the default, which
    // for `readOnly` means writable and for the graph means the quieter picture.
    return false;
  }
}

function remember(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // The setting still holds for this tab; it just will not survive a reload.
  }
}
