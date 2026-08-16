/**
 * `[[Wikilinks]]`, resolved against what the reader can actually open.
 *
 * A link is written as a title, and titles are encrypted. Only somebody holding the key
 * can turn one into a note id, which is why resolution happens here and never on the
 * server — and why a title that matches nothing stays local: sending it would publish the
 * unmatched text.
 */

/** `[[Title]]` or `[[Title|shown text]]`, not crossing a line. */
const LINK = /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g;

export interface Wikilink {
  /** The title as written, trimmed. */
  target: string;
  /** What to show; the target when no alias was given. */
  label: string;
  start: number;
  end: number;
}

export function parseWikilinks(body: string): Wikilink[] {
  const found: Wikilink[] = [];

  for (const match of body.matchAll(LINK)) {
    const target = (match[1] ?? '').trim();
    if (!target) continue;

    const alias = match[2]?.trim();

    found.push({
      target,
      label: alias || target,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return found;
}

export interface Resolvable {
  id: number;
  name: string;
}

export interface Resolution {
  /** Ids of notes the writer could resolve, deduplicated and stable in order. */
  resolved: number[];
  /** Titles that matched nothing this reader can see. They never leave the device. */
  unresolved: string[];
}

/**
 * Matches titles against notes, case-insensitively and ignoring surrounding space.
 *
 * Ambiguity is resolved by taking the lowest id rather than by guessing at intent: two
 * notes may legitimately share a title, and picking the older one at least makes the same
 * body resolve the same way twice.
 */
export function resolveWikilinks(body: string, notes: Resolvable[], self?: number): Resolution {
  const byTitle = new Map<string, number>();

  for (const note of notes) {
    const key = note.name.trim().toLowerCase();
    const existing = byTitle.get(key);

    if (existing === undefined || note.id < existing) byTitle.set(key, note.id);
  }

  const resolved: number[] = [];
  const unresolved: string[] = [];
  const seen = new Set<number>();

  for (const link of parseWikilinks(body)) {
    const id = byTitle.get(link.target.toLowerCase());

    if (id === undefined) {
      if (!unresolved.includes(link.target)) unresolved.push(link.target);
      continue;
    }

    // A note linking to itself draws a loop and says nothing.
    if (id === self || seen.has(id)) continue;

    seen.add(id);
    resolved.push(id);
  }

  return { resolved, unresolved };
}
