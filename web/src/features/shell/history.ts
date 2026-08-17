import { useEffect, useReducer, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Identity } from '@/crypto/identity';
import { useWorkspace } from '@/store/workspace';

import { type Place, pathOf, placeOf, samePath } from './place';

/**
 * Keeps the address bar and the shell pointing at the same thing, in both directions: what
 * the user opens becomes a history entry, and Back, Forward, the mouse's side buttons and
 * the system bindings all land on the state they name.
 *
 * The store stays the single source of truth. A URL that arrives from the history is
 * replayed into it; a store that moves on its own is written back out. Whichever side moved
 * last is the one that is copied, which is what keeps the two from chasing each other.
 *
 * Returns the vault the first URL asked for, so the initial load can go straight there
 * instead of opening the first vault and then switching.
 */
export function useShellHistory(identity: Identity | null): number | null {
  const location = useLocation();
  const navigate = useNavigate();

  const vaultId = useWorkspace((state) => state.vaultId);
  const view = useWorkspace((state) => state.view);
  const noteId = useWorkspace((state) => state.open?.note.id ?? null);
  const query = useWorkspace((state) => state.query);
  // Not read here, but a place waiting for a vault or a note is waiting for exactly these:
  // the effect has to run again when they arrive.
  const vaults = useWorkspace((state) => state.vaults);
  const notes = useWorkspace((state) => state.tree.notes);
  const loaded = useWorkspace((state) => state.loaded);
  const loading = useWorkspace((state) => state.loading);
  const syncing = useWorkspace((state) => state.syncing);

  const url = location.pathname + location.search;

  const initial = useRef(placeOf(location.pathname, location.search));
  const pending = useRef<Place | null>(initial.current);
  const synced = useRef(url);
  const applying = useRef(false);
  /**
   * The last move came from the history rather than from the UI, so a correction to the URL
   * belongs in that entry rather than on top of it — otherwise Back onto a note that no
   * longer exists would push the corrected place and trap the user between the two.
   */
  const replaying = useRef(true);
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    // A navigation reaches `window.location` at once but this hook one render later. Acting
    // on the stale one would undo the move that just happened.
    if (url !== window.location.pathname + window.location.search) return;

    if (url !== synced.current) {
      synced.current = url;
      pending.current = placeOf(location.pathname, location.search);
      replaying.current = true;
    }

    if (applying.current) return;

    const place = pending.current;

    if (place) {
      applying.current = true;

      void (async () => {
        try {
          if ((await applyPlace(place, identity)) === 'done') pending.current = null;
        } finally {
          applying.current = false;
        }

        // Only once the place has been consumed. Re-running one that is still waiting for
        // its data would be a busy loop; the effect's own dependencies bring it back when
        // the vault list or the tree arrives.
        if (pending.current === null) retry();
      })();

      return;
    }

    const next = pathOf({ vaultId, view, noteId, query });

    if (next === url) {
      replaying.current = false;
      return;
    }

    // A URL with no vault in it ("/") names no place of its own: it is a request for
    // whichever vault opens first. Writing that one in is a correction of the entry rather
    // than a move away from it, or the very first Back would land on it and go nowhere.
    const naming = vaultId !== null && placeOf(location.pathname, location.search).vaultId === null;

    // Typing in the search box must not leave one history entry per keystroke.
    navigate(next, { replace: replaying.current || naming || samePath(next, url) });
    synced.current = next;
    replaying.current = false;
  }, [
    attempt,
    identity,
    loaded,
    loading,
    location.pathname,
    location.search,
    navigate,
    noteId,
    notes,
    query,
    syncing,
    url,
    vaultId,
    vaults,
    view,
  ]);

  return initial.current.vaultId;
}

/**
 * 'later' means the place is not wrong, only early: the vault list or the tree it names has
 * not been read yet. The caller keeps it and tries again when that data lands.
 */
type Outcome = 'done' | 'later';

async function applyPlace(place: Place, identity: Identity | null): Promise<Outcome> {
  const store = useWorkspace.getState();

  if (place.vaultId !== null && place.vaultId !== store.vaultId) {
    if (!store.loaded || !identity) return 'later';

    // A vault this account no longer reaches is not worth waiting for. Nothing is applied
    // and the URL is corrected to whatever is actually open.
    if (!store.vaults.some((vault) => vault.id === place.vaultId)) return 'done';

    await store.selectVault(place.vaultId, identity);
  }

  const current = useWorkspace.getState();

  if (place.view === 'editor') {
    if (place.noteId === null) {
      if (current.open) current.closeNote();
    } else if (current.open?.note.id !== place.noteId) {
      const note = current.tree.notes.find((candidate) => candidate.id === place.noteId);

      // Still syncing: the note may yet appear. Otherwise it is gone, trashed or out of
      // reach, and the editor stays on what it has.
      if (!note) return current.loading || current.syncing ? 'later' : 'done';

      await current.openNote(note);
    }
  } else if (place.view === 'search' && place.query !== current.query) {
    current.setQuery(place.query);
  }

  // Last, because opening a note puts the editor back on screen by itself.
  useWorkspace.getState().setView(place.view);

  return 'done';
}
