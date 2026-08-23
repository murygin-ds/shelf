import type { NoteNode } from '@/api/workspace';
import { format } from '@/i18n';

/**
 * The decrypted index search runs against. It exists in memory only: persisting it would
 * put plaintext on disk and make the lock state a decoration.
 *
 * The design's promise — "searched locally on the decrypted index, no query leaves this
 * device" — is only true if the whole vault is cached, so coverage is tracked and shown
 * rather than assumed.
 */
export interface IndexedNote {
  id: number;
  title: string;
  body: string;
  folderId: number | null;
  path: string;
  tags: string[];
  updatedAt: string;
  haystack: string;
}

export interface SearchHit {
  note: IndexedNote;
  /** The line the match was found on, for the snippet the results list shows. */
  snippet: { before: string; match: string; after: string };
}

const SNIPPET_RADIUS = 60;
const TAG_PATTERN = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

export function extractTags(body: string): string[] {
  const tags = new Set<string>();

  // Composed first: `\p{L}` does not match a combining mark, so a decomposed «тёмный» would
  // otherwise be read as the tag «те». The inspector calls this on a live editor body, not
  // only on what the index already folded.
  for (const match of body.normalize('NFC').matchAll(TAG_PATTERN)) {
    if (match[1]) tags.add(match[1].toLowerCase());
  }

  return [...tags];
}

const TAG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

// Meta is one ciphertext the server caps at 8 KiB. A note that cannot be saved because of
// its tag list would be the worst way to find that out, so the list is bounded well short.
export const MAX_TAGS = 24;

/**
 * One spelling for both sources: `#Draft` written into a body and "Draft" chosen in the
 * panel have to become the same tag, or one note would answer to two of them.
 */
export function normalizeTag(raw: string): string | null {
  const text = raw.normalize('NFC').trim().replace(/^#+/, '').trim().toLowerCase();

  return TAG_SHAPE.test(text) ? text : null;
}

export function buildIndexEntry(note: NoteNode, body: string, path: string): IndexedNote {
  // NFC at the door, and only here. «Й» and «ё» each have a composed and a decomposed
  // spelling, and text pasted from a macOS source arrives decomposed while the same word
  // typed on a keyboard arrives composed — so one would not find the other. Normalising the
  // stored title and body rather than the haystack alone is what keeps the snippet honest:
  // its offsets are counted in UTF-16 units of these two strings, and a form change moves
  // them. It also unbreaks `#тег`, whose pattern has no place for a combining mark.
  const title = note.name.normalize('NFC');
  const text = body.normalize('NFC');

  const chosen = note.tags.flatMap((tag) => normalizeTag(tag) ?? []);
  const tags = [...new Set([...chosen, ...extractTags(text)])];

  return {
    id: note.id,
    title,
    body: text,
    folderId: note.folderId,
    path,
    tags,
    updatedAt: note.updatedAt,
    // Tags join the haystack: one chosen in the panel and never typed into the body would
    // otherwise be invisible to a `#tag` query, which is exactly how the sidebar searches.
    haystack: `${title}\n${text}\n${tags.map((tag) => `#${tag}`).join(' ')}`.toLowerCase(),
  };
}

export interface SearchFilters {
  folderId?: number | null;
  tag?: string;
}

export function search(
  index: IndexedNote[],
  query: string,
  filters: SearchFilters = {},
): SearchHit[] {
  // The same fold the index was built with, or the two would be spelling the query
  // differently and the offsets the snippet slices by would point at the wrong characters.
  const needle = query.trim().normalize('NFC').toLowerCase();
  if (!needle) return [];

  const hits: SearchHit[] = [];

  for (const note of index) {
    if (filters.folderId !== undefined && note.folderId !== filters.folderId) continue;
    if (filters.tag && !note.tags.includes(filters.tag)) continue;

    const at = note.haystack.indexOf(needle);
    if (at === -1) continue;

    hits.push({ note, snippet: snippetAround(note, needle, at) });
  }

  // Title matches first, then the most recently touched: the note someone is looking for
  // is usually one they were just in.
  return hits.sort((a, b) => {
    const byTitle = Number(inTitle(b, needle)) - Number(inTitle(a, needle));

    // A timestamp, so not `format.compare`: it collates digits numerically and would read
    // the fraction in `…00.5Z` as five rather than as a half.
    return byTitle !== 0 ? byTitle : b.note.updatedAt.localeCompare(a.note.updatedAt);
  });
}

function inTitle(hit: SearchHit, needle: string): boolean {
  return hit.note.title.toLowerCase().includes(needle);
}

function snippetAround(note: IndexedNote, needle: string, at: number): SearchHit['snippet'] {
  // The haystack is title + "\n" + body, so an offset past the title maps into the body.
  const offset = note.title.length + 1;
  const source = at >= offset ? note.body : note.title;
  const local = at >= offset ? at - offset : at;

  const start = Math.max(0, local - SNIPPET_RADIUS);
  const end = Math.min(source.length, local + needle.length + SNIPPET_RADIUS);

  return {
    before: (start > 0 ? '…' : '') + source.slice(start, local),
    match: source.slice(local, local + needle.length),
    after: source.slice(local + needle.length, end) + (end < source.length ? '…' : ''),
  };
}

export function allTags(index: IndexedNote[]): string[] {
  const counts = new Map<string, number>();

  for (const note of index) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || format.compare(a[0], b[0])).map(([tag]) => tag);
}
