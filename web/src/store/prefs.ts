import { create } from 'zustand';

/**
 * What this browser prefers, as opposed to what the account is allowed.
 *
 * Nothing here is a secret and nothing here is sealed: it is written in the clear to
 * localStorage, survives a reload and a lock, and says nothing to the server. A preference
 * that decided anything the server enforces would belong in the vault instead.
 */

const READ_ONLY_KEY = 'shelf.read-only';

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
}

export const usePrefs = create<PrefsState>((set) => ({
  readOnly: stored(),
  setReadOnly: (readOnly) => {
    remember(readOnly);
    set({ readOnly });
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

function stored(): boolean {
  try {
    return localStorage.getItem(READ_ONLY_KEY) === '1';
  } catch {
    // Private mode, storage switched off, or a test with no DOM. Writable is the default.
    return false;
  }
}

function remember(readOnly: boolean): void {
  try {
    if (readOnly) localStorage.setItem(READ_ONLY_KEY, '1');
    else localStorage.removeItem(READ_ONLY_KEY);
  } catch {
    // The mode still holds for this tab; it just will not survive a reload.
  }
}
