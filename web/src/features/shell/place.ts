import type { View } from '@/store/workspace';

/**
 * Where the shell is, in the form the address bar can carry: enough to put a reloaded tab
 * back where it was, and to give the Back button something to go back to.
 *
 * Ids are the server's own, so a link says nothing the server does not already know. Titles,
 * bodies and tags stay out of it — they are ciphertext and never travel in a URL.
 */
export interface Place {
  vaultId: number | null;
  view: View;
  /** Only the editor carries one: the other views keep the note open behind them. */
  noteId: number | null;
  query: string;
}

export function pathOf(place: Place): string {
  const root = place.vaultId === null ? '' : `/v/${place.vaultId}`;

  switch (place.view) {
    case 'search': {
      const query = place.query.trim();

      return `${root}/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
    }
    case 'graph':
      return `${root}/graph`;
    case 'trash':
      return `${root}/trash`;
    default:
      return place.noteId === null ? root || '/' : `${root}/n/${place.noteId}`;
  }
}

export function placeOf(pathname: string, search: string): Place {
  const parts = pathname.split('/').filter(Boolean);
  const vaultId = parts[0] === 'v' ? idOf(parts[1]) : null;
  const rest = vaultId === null ? parts : parts.slice(2);
  const query = new URLSearchParams(search).get('q') ?? '';

  switch (rest[0]) {
    case 'search':
      return { vaultId, view: 'search', noteId: null, query };
    case 'graph':
      return { vaultId, view: 'graph', noteId: null, query: '' };
    case 'trash':
      return { vaultId, view: 'trash', noteId: null, query: '' };
    case 'n':
      return { vaultId, view: 'editor', noteId: idOf(rest[1]), query: '' };
    default:
      return { vaultId, view: 'editor', noteId: null, query: '' };
  }
}

/** True when two URLs differ only in their query string. */
export function samePath(a: string, b: string): boolean {
  return a.split('?')[0] === b.split('?')[0];
}

function idOf(raw: string | undefined): number | null {
  const value = Number(raw);

  return Number.isInteger(value) && value > 0 ? value : null;
}
