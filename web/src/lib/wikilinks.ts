/**
 * `[[Wikilinks]]`, resolved against what the reader can actually open.
 *
 * A link is written as a title or a path, and both are encrypted. Only somebody holding the
 * key can turn one into a note id, which is why resolution happens here and never on the
 * server — and why a target that matches nothing stays local: sending it would publish the
 * unmatched text.
 *
 * The connector resolves the same way (`internal/mcp/links.go`). The graph is one artifact
 * both write into, so a body that draws an edge when a person saves it has to draw the same
 * edge when Claude writes it.
 */

/** `[[Title]]` or `[[Title|shown text]]`, not crossing a line. */
const LINK = /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g;

export interface Wikilink {
  /** The target as written, trimmed. */
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
  /** The full slash path, for callers that can build one. */
  path?: string;
}

export interface Resolution {
  /** Ids of notes the writer could resolve, deduplicated and stable in order. */
  resolved: number[];
  /** Targets that matched nothing this reader can see. They never leave the device. */
  unresolved: string[];
}

/** How both indexes are keyed: stray case and surrounding slashes name the same note. */
function fold(target: string): string {
  return target.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

/**
 * Indexes the notes a link can point at, by path and by title.
 *
 * Paths win over titles because a vault repeats titles: the tree Claude writes into gives
 * every project its own `CLAUDE.md`, and a bare `[[CLAUDE.md]]` cannot say which. Titles stay
 * resolvable, since that is what a person types, and a title two notes share settles on the
 * lower id — deterministic rather than a guess at intent, so the same body always leads to
 * the same place.
 */
export function linkTargets(notes: readonly Resolvable[]): ReadonlyMap<string, number> {
  const byTitle = new Map<string, number>();
  const byPath = new Map<string, number>();

  for (const note of notes) {
    const title = fold(note.name);
    const existing = byTitle.get(title);

    if (existing === undefined || note.id < existing) byTitle.set(title, note.id);

    if (note.path) byPath.set(fold(note.path), note.id);
  }

  // Paths last, so a path and a title that spell the same string settle on the path.
  return new Map([...byTitle, ...byPath]);
}

/** The note one target names, or undefined when this reader has nothing by that name. */
export function resolveTarget(
  target: string,
  targets: ReadonlyMap<string, number>,
): number | undefined {
  return targets.get(fold(target));
}

/**
 * The notes of a tree, each with the path that names it uniquely.
 *
 * A folder nobody can open still contributes its name to the paths below it, because that is
 * what those notes are called in every list the reader sees.
 */
export function resolvables(
  folders: readonly { id: number; parentId: number | null; name: string }[],
  notes: readonly { id: number; name: string; folderId: number | null }[],
): Resolvable[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<number, string>();

  const pathOf = (id: number, seen: Set<number>): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;

    const folder = byId.get(id);
    // A parent this reader does not have is not a cycle and not an error: the path simply
    // starts at the deepest folder that arrived.
    if (!folder || seen.has(id)) return '';

    seen.add(id);

    const parent = folder.parentId === null ? '' : pathOf(folder.parentId, seen);
    const path = parent ? `${parent}/${folder.name}` : folder.name;

    paths.set(id, path);

    return path;
  };

  return notes.map((note) => {
    const parent = note.folderId === null ? '' : pathOf(note.folderId, new Set());

    return { id: note.id, name: note.name, path: parent ? `${parent}/${note.name}` : note.name };
  });
}

/**
 * Matches the links in a body against the notes around it.
 *
 * The order of the result is the order the links appear in, which is what makes two saves of
 * an unchanged body produce the same set rather than a reshuffled one.
 */
export function resolveWikilinks(
  body: string,
  notes: readonly Resolvable[],
  self?: number,
): Resolution {
  const targets = linkTargets(notes);

  const resolved: number[] = [];
  const unresolved: string[] = [];
  const seen = new Set<number>();

  for (const link of parseWikilinks(body)) {
    const id = resolveTarget(link.target, targets);

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
