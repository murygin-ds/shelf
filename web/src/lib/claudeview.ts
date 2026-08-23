import type { FolderNode, NoteNode, Tree } from '@/api/workspace';
import { format } from '@/i18n';
import {
  AREAS,
  DECISIONS_PREFIX,
  FRONTMATTER_FIELDS,
  PROJECT_DOC,
  ROOT_DOC,
  SKILL_DOC,
  STATUS_FIELD,
} from '@/lib/claudeos-contract';
import type { IndexedNote } from '@/lib/search';

/**
 * Reads a Claude vault as what it is rather than as a folder tree.
 *
 * The tree view answers "what files are there", which is the wrong question here: a vault
 * used as a model's memory is a set of projects, skills, a log and an inbox, and the folders
 * are only how those are stored. Everything below turns the storage back into the shape
 * somebody actually thinks in.
 *
 * It is pure and it works off what is already in memory — the decrypted search index — so
 * opening this view costs no requests and no keys beyond the ones the tab already holds.
 */

export type ProjectStatus = 'planning' | 'active' | 'paused' | 'done' | 'unset';

export const STATUSES: ProjectStatus[] = ['planning', 'active', 'paused', 'done'];

export interface Project {
  folderId: number;
  /** The project's own CLAUDE.md, or null while it has none. */
  noteId: number | null;
  name: string;
  path: string;
  status: ProjectStatus;
  summary: string;
  /** Unfinished steps, in the order they are written. */
  next: string[];
  done: number;
  decisions: number;
  notes: number;
  updatedAt: string;
  /** Still the shape it was created with: nobody has filled it in. */
  blank: boolean;
}

export interface Skill {
  folderId: number;
  noteId: number | null;
  name: string;
  path: string;
  description: string;
  updatedAt: string;
  blank: boolean;
}

export interface MemoryMonth {
  noteId: number;
  month: string;
  entries: number;
  latest: string[];
  updatedAt: string;
}

export interface ContextDoc {
  noteId: number;
  name: string;
  filled: boolean;
  updatedAt: string;
}

export interface Loose {
  noteId: number;
  name: string;
  path: string;
  preview: string;
  updatedAt: string;
}

export interface ClaudeModel {
  /** The root document, which is what the model reads first. */
  rootId: number | null;
  projects: Project[];
  skills: Skill[];
  memory: MemoryMonth[];
  context: ContextDoc[];
  inbox: Loose[];
  /** Notes that belong to none of the above. Shown rather than hidden. */
  elsewhere: Loose[];
  /** Notes last written by the connector, newest first. */
  byClaude: Loose[];
}

/** A month file, which is what makes the log a timeline rather than a pile. */
const MONTH = /^(\d{4}-\d{2})(\.md)?$/;

/** What the template leaves behind for somebody to replace. */
const PLACEHOLDER = /<!--[\s\S]*?-->/g;

export function readClaudeVault(tree: Tree, index: IndexedNote[]): ClaudeModel {
  const paths = folderPaths(tree.folders);
  const bodies = new Map(index.map((entry) => [entry.id, entry.body]));

  const byFolder = new Map<number | null, NoteNode[]>();
  for (const note of tree.notes) {
    const list = byFolder.get(note.folderId) ?? [];
    list.push(note);
    byFolder.set(note.folderId, list);
  }

  const area = (name: string): FolderNode | undefined =>
    tree.folders.find((folder) => folder.parentId === null && folder.name === name);

  const root = (byFolder.get(null) ?? []).find((note) => note.name === ROOT_DOC);

  return {
    rootId: root?.id ?? null,
    projects: readProjects(tree, paths, byFolder, bodies, area(AREAS.projects)),
    skills: readSkills(tree, paths, byFolder, bodies, area(AREAS.skills)),
    memory: readMemory(byFolder, bodies, area(AREAS.memory)),
    context: readContext(byFolder, bodies, area(AREAS.context)),
    inbox: loose(byFolder.get(area(AREAS.inbox)?.id ?? -1) ?? [], paths, bodies),
    elsewhere: readElsewhere(tree, paths, bodies),
    byClaude: [],
  };
}

/**
 * Marks what the connector wrote last. It is a separate pass because the connector's user id
 * comes from the API rather than from the tree, and the view is useful before it arrives.
 */
export function attributeToClaude(model: ClaudeModel, tree: Tree, connectorUserID: number | null): ClaudeModel {
  if (connectorUserID === null) return { ...model, byClaude: [] };

  const paths = folderPaths(tree.folders);
  const bodies = new Map<number, string>();

  // Timestamps rather than names, so this stays a plain string comparison: `format.compare`
  // collates digits numerically and would read the fraction in `…00.5Z` as 5, not as a half.
  const written = tree.notes
    .filter((note) => note.updatedBy === connectorUserID)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { ...model, byClaude: loose(written, paths, bodies) };
}

function readProjects(
  tree: Tree,
  paths: Map<number, string>,
  byFolder: Map<number | null, NoteNode[]>,
  bodies: Map<number, string>,
  root: FolderNode | undefined,
): Project[] {
  if (!root) return [];

  return tree.folders
    .filter((folder) => folder.parentId === root.id && !folder.name.startsWith('_'))
    .map((folder) => {
      const notes = byFolder.get(folder.id) ?? [];
      const doc = notes.find((note) => note.name === PROJECT_DOC);
      const body = doc ? (bodies.get(doc.id) ?? '') : '';
      const steps = todos(body);

      const decisions = notes.find((note) => note.name.toLowerCase().startsWith(DECISIONS_PREFIX));

      return {
        folderId: folder.id,
        noteId: doc?.id ?? null,
        name: folder.name,
        path: paths.get(folder.id) ?? folder.name,
        status: status(body),
        summary: summary(body),
        next: steps.open,
        done: steps.done,
        decisions: decisions ? entries(bodies.get(decisions.id) ?? '') : 0,
        notes: countUnder(tree, byFolder, folder.id),
        updatedAt: newest([folder.updatedAt, ...notes.map((note) => note.updatedAt)]),
        blank: !doc || bare(body),
      };
    })
    .sort(byRank);
}

function readSkills(
  tree: Tree,
  paths: Map<number, string>,
  byFolder: Map<number | null, NoteNode[]>,
  bodies: Map<number, string>,
  root: FolderNode | undefined,
): Skill[] {
  if (!root) return [];

  return tree.folders
    .filter((folder) => folder.parentId === root.id && !folder.name.startsWith('_'))
    .map((folder) => {
      const notes = byFolder.get(folder.id) ?? [];
      const doc = notes.find((note) => note.name === SKILL_DOC);
      const body = doc ? (bodies.get(doc.id) ?? '') : '';

      return {
        folderId: folder.id,
        noteId: doc?.id ?? null,
        name: frontmatter(body).name || folder.name,
        path: paths.get(folder.id) ?? folder.name,
        description: frontmatter(body).description,
        updatedAt: newest([folder.updatedAt, ...notes.map((note) => note.updatedAt)]),
        blank: !doc || bare(body),
      };
    })
    .sort((a, b) => format.compare(a.name, b.name));
}

function readMemory(
  byFolder: Map<number | null, NoteNode[]>,
  bodies: Map<number, string>,
  root: FolderNode | undefined,
): MemoryMonth[] {
  if (!root) return [];

  return (byFolder.get(root.id) ?? [])
    .flatMap((note) => {
      const match = MONTH.exec(note.name);
      if (!match) return [];

      const body = bodies.get(note.id) ?? '';
      const bullets = lines(body).filter((line) => line.startsWith('- '));

      return [
        {
          noteId: note.id,
          month: match[1] as string,
          entries: bullets.length,
          latest: bullets.slice(-3).reverse().map(strip),
          updatedAt: note.updatedAt,
        },
      ];
    })
    .sort((a, b) => b.month.localeCompare(a.month));
}

function readContext(
  byFolder: Map<number | null, NoteNode[]>,
  bodies: Map<number, string>,
  root: FolderNode | undefined,
): ContextDoc[] {
  if (!root) return [];

  return (byFolder.get(root.id) ?? [])
    .map((note) => ({
      noteId: note.id,
      name: note.name,
      filled: !bare(bodies.get(note.id) ?? ''),
      updatedAt: note.updatedAt,
    }))
    .sort((a, b) => format.compare(a.name, b.name));
}

/** Notes outside the five areas. A vault used for a while always grows some. */
function readElsewhere(tree: Tree, paths: Map<number, string>, bodies: Map<number, string>): Loose[] {
  const known = new Set(
    tree.folders
      .filter((folder) => folder.parentId === null && Object.values(AREAS).includes(folder.name as never))
      .map((folder) => folder.id),
  );

  const inside = (folderId: number | null): boolean => {
    let at = folderId;

    while (at !== null) {
      if (known.has(at)) return true;

      at = tree.folders.find((folder) => folder.id === at)?.parentId ?? null;
    }

    return false;
  };

  const strays = tree.notes.filter(
    (note) => !inside(note.folderId) && !(note.folderId === null && note.name === ROOT_DOC),
  );

  return loose(strays, paths, bodies);
}

function loose(notes: NoteNode[], paths: Map<number, string>, bodies: Map<number, string>): Loose[] {
  return notes.map((note) => ({
    noteId: note.id,
    name: note.name,
    path: note.folderId === null ? '' : (paths.get(note.folderId) ?? ''),
    preview: preview(bodies.get(note.id) ?? ''),
    updatedAt: note.updatedAt,
  }));
}

function countUnder(tree: Tree, byFolder: Map<number | null, NoteNode[]>, folderId: number): number {
  const children = tree.folders.filter((folder) => folder.parentId === folderId);

  return (
    (byFolder.get(folderId) ?? []).length +
    children.reduce((sum, child) => sum + countUnder(tree, byFolder, child.id), 0)
  );
}

/** Active first, then what is waiting, then what is finished. Stale ones sink within a rank. */
function byRank(a: Project, b: Project): number {
  const rank = (project: Project): number =>
    ({ active: 0, planning: 1, unset: 2, paused: 3, done: 4 })[project.status];

  return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
}

export function folderPaths(folders: FolderNode[]): Map<number, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<number, string>();

  const walk = (folder: FolderNode): string => {
    const known = paths.get(folder.id);
    if (known !== undefined) return known;

    const parent = folder.parentId === null ? null : byId.get(folder.parentId);
    const path = parent ? `${walk(parent)}/${folder.name}` : folder.name;

    paths.set(folder.id, path);

    return path;
  };

  for (const folder of folders) walk(folder);

  return paths;
}

// Parsing the template's own conventions. Everything here tolerates a document somebody
// rewrote by hand: a field that is missing reads as unset rather than as an error.

export function status(body: string): ProjectStatus {
  const found = field(body, STATUS_FIELD).toLowerCase();

  return (STATUSES as string[]).includes(found) ? (found as ProjectStatus) : 'unset';
}

export function field(body: string, name: string): string {
  // Markdown puts the colon on either side of the emphasis — `**Status:** x` and
  // `**Status**: x` are both written, and a list marker may sit in front of either.
  const pattern = new RegExp(`^[-*\\s]*\\*{0,2}\\s*${name}\\s*\\*{0,2}\\s*:\\s*\\*{0,2}\\s*(.+)$`, 'im');
  const raw = pattern.exec(body)?.[1] ?? '';

  return strip(raw);
}

export function todos(body: string): { open: string[]; done: number } {
  const open: string[] = [];
  let done = 0;

  for (const line of lines(body)) {
    const match = /^[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
    if (!match) continue;

    if (match[1] === ' ') {
      const text = strip(match[2] ?? '');
      if (text) open.push(text);
    } else {
      done += 1;
    }
  }

  return { open, done };
}

/** The first real sentence of a document, for a card that has room for one line. */
export function summary(body: string): string {
  for (const line of lines(body)) {
    if (line.startsWith('#') || line.startsWith('**') || line.startsWith('---')) continue;
    // A step is not a description of the thing it belongs to, and an emptied-out one is not
    // even that — a summary of "[ ]" says less than nothing.
    if (/^[-*]\s*(\[[ xX]\])?/.test(line) && !strip(line.replace(/^[-*]\s*\[[ xX]\]\s*/, ''))) {
      continue;
    }

    const text = strip(line);
    if (text) return text;
  }

  return '';
}

export function frontmatter(body: string): { name: string; description: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(body.trimStart());
  const block = match?.[1] ?? '';

  const [name, description] = FRONTMATTER_FIELDS;

  return { name: field(block, name), description: field(block, description) };
}

/** How many dated entries a decisions log holds, ignoring the heading it was created with. */
export function entries(body: string): number {
  return (body.match(/^##\s+\d{4}-\d{2}-\d{2}/gm) ?? []).length;
}

/**
 * True when a document is still only its scaffolding.
 *
 * Not a length: a short document somebody wrote is filled in, and a long one made entirely of
 * headings and `<!-- fill this in -->` is not. What is asked instead is whether any slot has
 * a value — strip the parts the template supplied and see whether anything is left.
 */
export function bare(body: string): boolean {
  const withoutFrontmatter = body.trimStart().replace(/^---\n[\s\S]*?\n---/, '');

  const residue = withoutFrontmatter
    .replace(PLACEHOLDER, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    // Headings, rules and table rows are structure the template drew.
    .filter((line) => !/^#/.test(line) && !/^-{3,}$/.test(line) && !/^\|/.test(line))
    // A list marker whose item was a placeholder, with or without a checkbox on it, and a
    // label with nothing after the colon.
    .filter((line) => !/^[-*]\s*(\[[ xX]\])?\s*$/.test(line))
    // `\w` is ASCII, so «**Статус:**» with nothing after it used to survive this filter and
    // an untouched Russian template read as filled in.
    .filter((line) => !/^[-*]?\s*\*{0,2}[\p{L}\p{N} ._-]+\*{0,2}\s*:\s*\*{0,2}\s*$/u.test(line))
    .join('')
    .trim();

  return residue === '';
}

function preview(body: string): string {
  const text = summary(body);

  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function lines(body: string): string[] {
  return body.split('\n').map((line) => line.trim());
}

/** Drops the markdown a card would otherwise render as literal punctuation. */
function strip(raw: string): string {
  return raw
    .replace(PLACEHOLDER, '')
    .replace(/^[-*]\s*\[[ xX]\]\s*/, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/^[-*]\s+/, '')
    .trim();
}

function newest(dates: string[]): string {
  return dates.filter(Boolean).sort().at(-1) ?? '';
}
