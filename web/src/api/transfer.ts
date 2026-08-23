import { utf8 } from '@/crypto/bytes';
import type { Identity } from '@/crypto/identity';
import type { ScopeKeyring } from '@/crypto/keyring';
import {
  MANIFEST_PATH,
  archiveFilename,
  manifest,
  planArchive,
  type ImportPlan,
  type PlannedNote,
  type Skipped,
} from '@/lib/archive';
import { resolvables, resolveWikilinks } from '@/lib/wikilinks';
import { zip, type ZipEntry } from '@/lib/zip';

import { ApiError, OfflineError } from './client';
import * as graph from './graph';
import * as ws from './workspace';

/**
 * Carrying a vault out of Shelf and back in.
 *
 * Both directions are compositions of the ordinary endpoints, because there is no other way:
 * the server holds ciphertext, so the only place an archive can be built or read is the device
 * that holds the keys. That also means an import is one request per node — `parent_id` is a
 * server id, and it exists only once the parent has been created.
 */
export interface ExportProgress {
  done: number;
  total: number;
}

export interface VaultExport {
  blob: Blob;
  filename: string;
  folders: number;
  notes: number;
  skipped: Skipped[];
}

const EMPTY = new Uint8Array(0);

/** The server's ceiling on outgoing links from one note. */
const MAX_LINKS = 500;

/** How many failures in a row mean the run is not going to recover. */
const GIVE_UP_AFTER = 10;

export async function exportVault(
  vault: ws.Vault,
  tree: ws.Tree,
  keyring: ScopeKeyring,
  onProgress?: (progress: ExportProgress) => void,
  at = new Date(),
): Promise<VaultExport> {
  const plan = planArchive(tree);
  const skipped = [...plan.skipped];
  const written: PlannedNote[] = [];

  const entries: ZipEntry[] = plan.directories.map((path) => ({ path, data: EMPTY }));
  const total = plan.notes.length;

  onProgress?.({ done: 0, total });

  // Bodies come from the server rather than from the in-memory index: index coverage is
  // partial by design, and an export is a snapshot, not a best effort.
  for (let from = 0; from < plan.notes.length; from += ws.BULK_LIMIT) {
    const page = plan.notes.slice(from, from + ws.BULK_LIMIT);
    const { files } = await ws.fetchBodies(
      vault.id,
      page.map((planned) => planned.node.id),
    );
    const bodies = new Map(files.map((dto) => [dto.id, dto]));

    for (const planned of page) {
      const dto = bodies.get(planned.node.id);

      // Purged between reading the tree and fetching this page. Writing an empty file for it
      // would read as a note that lost its text.
      if (!dto) {
        skipped.push({ kind: 'note', ref: String(planned.node.id), reason: 'missing' });
        continue;
      }

      const body = await ws.openBody(dto, dto.content ?? '', dto.content_nonce ?? '', keyring);

      if (body === null) {
        skipped.push({ kind: 'note', ref: String(planned.node.id), reason: 'no-key' });
        continue;
      }

      entries.push({ path: planned.entry.path, data: utf8(body) });
      written.push(planned);
    }

    onProgress?.({ done: Math.min(from + page.length, total), total });
  }

  // The manifest lists what the archive actually holds, so a note that could not be read does
  // not come back on import as a file that has gone missing.
  entries.push({
    path: MANIFEST_PATH,
    data: utf8(JSON.stringify(manifest(vault, { ...plan, notes: written }, skipped, at), null, 2)),
  });

  return {
    blob: await zip(entries, at),
    filename: archiveFilename(vault.name, at),
    folders: plan.folders.length,
    notes: written.length,
    skipped,
  };
}

export interface ImportProgress {
  phase: 'vault' | 'folders' | 'notes' | 'links';
  done: number;
  total: number;
}

export interface ImportFailure {
  kind: 'folder' | 'note';
  name: string;
  message: string;
}

export interface ImportReport {
  vaultId: number;
  folders: number;
  notes: number;
  skipped: Skipped[];
  failures: ImportFailure[];
}

/**
 * Creates a vault and fills it from an archive.
 *
 * Nothing here reuses the ids the archive carries. They name slots in the vault the archive
 * came from, and the additional data every ciphertext is bound to is built from the *new*
 * ids — reusing them would seal these bodies to a place they do not live.
 *
 * A node that fails is counted and stepped over rather than unwound: the vault is new and
 * threatens nothing, while deleting it would destroy whatever did land.
 */
export async function importVault(
  plan: ImportPlan,
  name: string,
  identity: Identity,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportReport> {
  onProgress?.({ phase: 'vault', done: 0, total: 1 });

  const created = await ws.createVault(name, plan.vault.icon, identity);
  const vault = (await ws.listVaults(identity)).find((candidate) => candidate.id === created.id);

  if (!vault) throw new Error('the new vault could not be read back');

  const keyring = await ws.loadKeyring(vault.id, identity);
  const root: ws.Scope = {
    id: vault.keyScopeId,
    clientId: vault.keyScopeClientId,
    version: vault.keyVersion,
  };

  const failures: ImportFailure[] = [];
  const folders = new Map<string, ws.FolderNode>();
  let consecutive = 0;

  const record = (kind: 'folder' | 'note', label: string, cause: unknown) => {
    if (cause instanceof OfflineError) throw cause;

    failures.push({ kind, name: label, message: describe(cause) });
    consecutive += 1;

    if (consecutive >= GIVE_UP_AFTER) {
      throw new Error(`${GIVE_UP_AFTER} nodes in a row failed — the import stopped there`);
    }
  };

  for (const [done, folder] of plan.folders.entries()) {
    onProgress?.({ phase: 'folders', done, total: plan.folders.length });

    // A folder whose parent failed is created at the root rather than dropped: its notes are
    // worth more than the nesting they lost.
    const parent = folder.parent === null ? undefined : folders.get(folder.parent);

    try {
      const node = await ws.createFolder(
        vault.id,
        parent?.id ?? null,
        folder.name,
        parent ? ws.scopeOfNode(parent) : root,
        keyring,
      );

      await decorate(node, 'folder', folder.icon, folder.tags, keyring);
      folders.set(folder.uid, node);
      consecutive = 0;
    } catch (cause) {
      record('folder', folder.name, cause);
    }
  }

  const imported: Array<{ node: ws.NoteNode; body: string }> = [];

  for (const [done, note] of plan.notes.entries()) {
    onProgress?.({ phase: 'notes', done, total: plan.notes.length });

    const folder = note.folder === null ? undefined : folders.get(note.folder);

    try {
      const node = await ws.createNote(
        vault.id,
        folder?.id ?? null,
        note.name,
        folder ? ws.scopeOfNode(folder) : root,
        keyring,
      );

      // A note is created with an empty body, so the text is a second write — which is also
      // the only one that carries a signature.
      const contentSeq = note.body
        ? await ws.writeNote(node, note.body, node.contentSeq, keyring, identity)
        : node.contentSeq;

      await decorate(node, 'file', note.icon, note.tags, keyring);
      imported.push({ node: { ...node, contentSeq }, body: note.body });
      consecutive = 0;
    } catch (cause) {
      record('note', note.name, cause);
    }
  }

  await relink(imported, [...folders.values()], onProgress);

  return {
    vaultId: vault.id,
    folders: folders.size,
    notes: imported.length,
    skipped: plan.skipped,
    failures,
  };
}

/**
 * Records the wikilink graph once every note exists.
 *
 * Links resolve by path and by title, and both came across exactly, so the graph the archive
 * described comes back — minus the edges pointing at notes that did not. The folders are
 * needed for the same reason the connector reads the whole tree: a path is the names of a
 * note's ancestors. A failure here is not worth failing the import over: the bodies are
 * written, only the graph is behind.
 */
async function relink(
  imported: ReadonlyArray<{ node: ws.NoteNode; body: string }>,
  folders: readonly ws.FolderNode[],
  onProgress?: (progress: ImportProgress) => void,
): Promise<void> {
  const linking = imported.filter((entry) => entry.body.includes('[['));
  const notes = resolvables(
    folders,
    imported.map((entry) => entry.node),
  );

  for (const [done, entry] of linking.entries()) {
    onProgress?.({ phase: 'links', done, total: linking.length });

    const { resolved } = resolveWikilinks(entry.body, notes, entry.node.id);
    if (resolved.length === 0) continue;

    await graph.setLinks(entry.node.id, resolved.slice(0, MAX_LINKS)).catch(() => undefined);
  }
}

/** Writes back the icon and tags a fresh node has no way to carry. */
async function decorate(
  node: ws.FolderNode | ws.NoteNode,
  kind: 'folder' | 'file',
  icon: string | undefined,
  tags: readonly string[],
  keyring: ScopeKeyring,
): Promise<void> {
  if (!icon && tags.length === 0) return;

  await ws.writeMeta(node, kind, { ...(icon ? { icon } : {}), tags }, keyring);
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message || `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.message || cause.name;

  return 'something went wrong';
}
