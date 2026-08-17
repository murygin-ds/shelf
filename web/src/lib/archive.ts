import type { FolderNode, NoteNode, Tree, Vault } from '@/api/workspace';
import { fromUtf8 } from '@/crypto/bytes';
import { ICON_NAMES } from '@/ui/Icon';

import { MAX_TAGS, normalizeTag } from './search';

/**
 * The Shelf archive: a plain zip of markdown, plus a manifest that carries what a file name
 * cannot.
 *
 * Two rules make the round trip exact. The manifest is authoritative — names, icons, tags and
 * the shape of the tree are read from it and never inferred from paths — so a path is free to
 * be mangled into whatever a file system will accept. And a note file holds the body and
 * nothing else: no front matter to add on the way out and strip on the way back, which is the
 * step that would otherwise eat a body legitimately starting with `---`.
 */
export const ARCHIVE_FORMAT = 'shelf/vault';
export const ARCHIVE_VERSION = 1;
export const MANIFEST_PATH = 'shelf.json';
export const NOTES_ROOT = 'notes/';

/**
 * A body is padded to a 4 KiB block and gains an AEAD tag before it is sent, and the server
 * takes 4 MiB of ciphertext.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024 - 4096 - 16;

/** Matches the server's own ceiling on a folder chain. */
const MAX_DEPTH = 32;

/** Meta is one ciphertext with an 8192-byte ceiling, and it is not padded. */
const MAX_NAME = 200;

const MAX_SEGMENT = 80;
const UNTITLED = 'Untitled';

export type SkipReason = 'locked' | 'no-key' | 'missing' | 'too-large' | 'too-deep' | 'orphaned';

/** A node that did not make it, named the way the side that skipped it knows it. */
export interface Skipped {
  kind: 'folder' | 'note';
  ref: string;
  reason: SkipReason;
}

export interface ArchiveFolder {
  uid: string;
  parent: string | null;
  name: string;
  icon?: string;
  tags: string[];
  position: number;
  path: string;
}

export interface ArchiveNote {
  uid: string;
  folder: string | null;
  name: string;
  icon?: string;
  tags: string[];
  updated_at: string;
  path: string;
}

export interface ArchiveManifest {
  format: string;
  version: number;
  exported_at: string;
  vault: { name: string; icon?: string };
  folders: ArchiveFolder[];
  notes: ArchiveNote[];
  skipped: Skipped[];
}

export interface PlannedNote {
  node: NoteNode;
  entry: ArchiveNote;
}

export interface ArchivePlan {
  /** Directory entries, parents first, so an empty folder still unpacks as a folder. */
  directories: string[];
  folders: ArchiveFolder[];
  notes: PlannedNote[];
  skipped: Skipped[];
}

/**
 * Lays the tree out as paths.
 *
 * A locked folder takes its whole subtree with it: without a readable name there is no
 * directory to put the children in, and inventing one would file real notes under a heading
 * nobody wrote.
 */
export function planArchive(tree: Tree): ArchivePlan {
  const childFolders = new Map<number | null, FolderNode[]>();
  for (const folder of tree.folders) {
    childFolders.set(folder.parentId, [...(childFolders.get(folder.parentId) ?? []), folder]);
  }

  const childNotes = new Map<number | null, NoteNode[]>();
  for (const note of tree.notes) {
    childNotes.set(note.folderId, [...(childNotes.get(note.folderId) ?? []), note]);
  }

  const plan: ArchivePlan = { directories: [], folders: [], notes: [], skipped: [] };

  const bury = (folder: FolderNode) => {
    plan.skipped.push({ kind: 'folder', ref: String(folder.id), reason: 'locked' });

    for (const child of childFolders.get(folder.id) ?? []) bury(child);
    for (const note of childNotes.get(folder.id) ?? []) {
      plan.skipped.push({ kind: 'note', ref: String(note.id), reason: 'locked' });
    }
  };

  const walk = (parentId: number | null, parentUid: string | null, at: string) => {
    const taken = new Set<string>();

    for (const folder of byPosition(childFolders.get(parentId) ?? [])) {
      if (folder.locked) {
        bury(folder);
        continue;
      }

      const path = `${at}${unique(taken, segment(folder.name), '')}/`;

      plan.directories.push(path);
      plan.folders.push({
        uid: folder.clientId,
        parent: parentUid,
        name: folder.name,
        ...(folder.icon ? { icon: folder.icon } : {}),
        tags: [...folder.tags],
        position: folder.position,
        path,
      });

      walk(folder.id, folder.clientId, path);
    }

    for (const note of byName(childNotes.get(parentId) ?? [])) {
      if (note.locked) {
        plan.skipped.push({ kind: 'note', ref: String(note.id), reason: 'locked' });
        continue;
      }

      plan.notes.push({
        node: note,
        entry: {
          uid: note.clientId,
          folder: parentUid,
          name: note.name,
          ...(note.icon ? { icon: note.icon } : {}),
          tags: [...note.tags],
          updated_at: note.updatedAt,
          path: `${at}${unique(taken, segment(note.name), '.md')}`,
        },
      });
    }
  };

  walk(null, null, NOTES_ROOT);

  return plan;
}

/** The manifest, written once the bodies are in and the skipped list is final. */
export function manifest(
  vault: Vault,
  plan: ArchivePlan,
  skipped: readonly Skipped[],
  exportedAt: Date,
): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: exportedAt.toISOString(),
    vault: { name: vault.name, ...(vault.emoji ? { icon: vault.emoji } : {}) },
    folders: plan.folders,
    notes: plan.notes.map((planned) => planned.entry),
    skipped: [...skipped],
  };
}

export function archiveFilename(vaultName: string, at: Date): string {
  const slug = vaultName
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  return `shelf-${slug ? `${slug}-` : ''}${at.toISOString().slice(0, 10)}.zip`;
}

export interface ImportFolder {
  uid: string;
  parent: string | null;
  name: string;
  icon?: string;
  tags: string[];
}

export interface ImportNote {
  uid: string;
  folder: string | null;
  name: string;
  icon?: string;
  tags: string[];
  body: string;
}

export interface ImportPlan {
  vault: { name: string; icon?: string };
  exportedAt: string;
  /** Parents before children: `parent_id` on the server exists only once the parent does. */
  folders: ImportFolder[];
  notes: ImportNote[];
  skipped: Skipped[];
}

/**
 * Reads an archive back into something that can be created.
 *
 * Everything here is treated as input rather than as something Shelf wrote: an archive is a
 * file on a disk, and it may have been edited, repacked or truncated since it was written.
 */
export function parseArchive(files: Map<string, Uint8Array>): ImportPlan {
  const root = manifestRoot(files);
  const raw = files.get(`${root}${MANIFEST_PATH}`);

  if (!raw) throw new Error(`this is not a Shelf archive — it carries no ${MANIFEST_PATH}`);

  const read = parseManifest(raw);
  const skipped: Skipped[] = [];

  const byUid = new Map<string, ArchiveFolder>();
  for (const folder of read.folders) {
    if (folder && typeof folder.uid === 'string') byUid.set(folder.uid, folder);
  }

  const ranked: { folder: ArchiveFolder; depth: number }[] = [];

  for (const folder of read.folders) {
    if (!folder || typeof folder.uid !== 'string') continue;

    const depth = depthOf(folder, byUid);

    if (depth === null) {
      skipped.push({ kind: 'folder', ref: folder.uid, reason: 'orphaned' });
      continue;
    }

    if (depth > MAX_DEPTH) {
      skipped.push({ kind: 'folder', ref: folder.uid, reason: 'too-deep' });
      continue;
    }

    ranked.push({ folder, depth });
  }

  ranked.sort((a, b) => a.depth - b.depth);

  const kept = new Set<string>();
  const folders: ImportFolder[] = [];

  for (const { folder } of ranked) {
    const parent = folder.parent ?? null;

    // Shallowest first, so a parent missing by now was dropped — and its children go with it
    // rather than being lifted to the root under a heading that no longer exists.
    if (parent !== null && !kept.has(parent)) {
      skipped.push({ kind: 'folder', ref: folder.uid, reason: 'orphaned' });
      continue;
    }

    kept.add(folder.uid);
    folders.push({
      uid: folder.uid,
      parent,
      ...label(folder.name, folder.icon),
      tags: tags(folder.tags),
    });
  }

  const notes: ImportNote[] = [];

  for (const note of read.notes) {
    if (!note || typeof note.uid !== 'string' || typeof note.path !== 'string') continue;

    const bytes = files.get(`${root}${note.path}`);

    if (!bytes) {
      skipped.push({ kind: 'note', ref: note.uid, reason: 'missing' });
      continue;
    }

    if (bytes.length > MAX_BODY_BYTES) {
      skipped.push({ kind: 'note', ref: note.uid, reason: 'too-large' });
      continue;
    }

    notes.push({
      uid: note.uid,
      // A note whose folder was dropped is kept at the root: the body is the point, and losing
      // it because its folder was unreadable takes away more than it protects.
      folder: note.folder !== null && kept.has(note.folder ?? '') ? note.folder : null,
      ...label(note.name, note.icon),
      tags: tags(note.tags),
      body: fromUtf8(bytes),
    });
  }

  return {
    vault: label(read.vault?.name, read.vault?.icon),
    exportedAt: typeof read.exported_at === 'string' ? read.exported_at : '',
    folders,
    notes,
    skipped,
  };
}

/** A name and an icon as the app will accept them, whatever the archive says. */
function label(rawName: unknown, rawIcon: unknown): { name: string; icon?: string } {
  const known = typeof rawIcon === 'string' && (ICON_NAMES as readonly string[]).includes(rawIcon);

  // An icon the app cannot draw is worse than none: the row would render an empty box.
  return { name: name(rawName), ...(known ? { icon: rawIcon as string } : {}) };
}

function parseManifest(raw: Uint8Array): ArchiveManifest {
  let read: ArchiveManifest;

  try {
    read = JSON.parse(fromUtf8(raw)) as ArchiveManifest;
  } catch {
    throw new Error(`the ${MANIFEST_PATH} in this archive is not readable`);
  }

  if (read?.format !== ARCHIVE_FORMAT) throw new Error('this is not a Shelf archive');

  if (typeof read.version !== 'number' || read.version > ARCHIVE_VERSION) {
    throw new Error('this archive was written by a newer version of Shelf');
  }

  if (!Array.isArray(read.folders) || !Array.isArray(read.notes)) {
    throw new Error(`the ${MANIFEST_PATH} in this archive is incomplete`);
  }

  return read;
}

/**
 * Where the archive really starts.
 *
 * Unpacking and repacking through a system tool nests everything one folder deeper, and what
 * comes back is otherwise a perfectly good archive.
 */
function manifestRoot(files: Map<string, Uint8Array>): string {
  if (files.has(MANIFEST_PATH)) return '';

  const nested = [...files.keys()].filter((path) => path.endsWith(`/${MANIFEST_PATH}`));
  const only = nested.length === 1 ? nested[0] : undefined;

  return only ? only.slice(0, -MANIFEST_PATH.length) : '';
}

/** How deep a folder sits, or null when its chain is broken or loops back on itself. */
function depthOf(folder: ArchiveFolder, folders: Map<string, ArchiveFolder>): number | null {
  const seen = new Set<string>([folder.uid]);
  let current = folder;
  let depth = 0;

  while (current.parent !== null && current.parent !== undefined) {
    const parent = folders.get(current.parent);

    if (!parent || seen.has(parent.uid)) return null;

    seen.add(parent.uid);
    current = parent;
    depth += 1;

    if (depth > MAX_DEPTH) return depth;
  }

  return depth;
}

function name(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';

  return [...text].slice(0, MAX_NAME).join('') || UNTITLED;
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const clean = value.flatMap((tag) => (typeof tag === 'string' ? (normalizeTag(tag) ?? []) : []));

  return [...new Set(clean)].slice(0, MAX_TAGS);
}

// Control characters, and the punctuation Windows or macOS refuse in a name. Everything
// else — spaces, brackets, dashes, any script — is left alone: a mangled name helps nobody.
const FORBIDDEN = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * One name, as a file system will take it.
 *
 * Lossy on purpose — the manifest holds the real name, so a path only has to be legal,
 * recognisable and unique.
 */
export function segment(raw: string): string {
  const cleaned = [...raw.replace(FORBIDDEN, '-').trim()].slice(0, MAX_SEGMENT).join('');
  // Windows drops trailing dots and spaces silently, and a name that does not survive being
  // written is a name the archive lies about.
  const trimmed = cleaned.replace(/[. ]+$/, '').trim();

  if (!trimmed) return UNTITLED;

  return RESERVED.test(trimmed) ? `_${trimmed}` : trimmed;
}

/**
 * Keeps sibling paths apart.
 *
 * Case-folded and NFC-normalised, because APFS and NTFS both treat `Notes.md` and `notes.md`
 * as one file: the archive would hold two entries and the unpacked folder one.
 */
export function unique(taken: Set<string>, base: string, extension: string): string {
  const key = (candidate: string) => candidate.normalize('NFC').toLowerCase();

  let candidate = `${base}${extension}`;

  for (let n = 2; taken.has(key(candidate)); n += 1) {
    candidate = `${base} (${n})${extension}`;
  }

  taken.add(key(candidate));

  return candidate;
}

function byPosition(folders: readonly FolderNode[]): FolderNode[] {
  return [...folders].sort((a, b) => a.position - b.position || a.id - b.id);
}

function byName(notes: readonly NoteNode[]): NoteNode[] {
  return [...notes].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}
