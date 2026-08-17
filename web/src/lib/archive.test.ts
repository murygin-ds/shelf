import { describe, expect, it } from 'vitest';

import type { FolderNode, NoteNode, Tree, Vault } from '@/api/workspace';
import { utf8 } from '@/crypto/bytes';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  MANIFEST_PATH,
  archiveFilename,
  manifest,
  parseArchive,
  planArchive,
  segment,
  unique,
  type ArchiveManifest,
} from './archive';
import { unzip, zip } from './zip';

const AT = '2026-08-17T10:00:00.000Z';

function folder(id: number, name: string, extra: Partial<FolderNode> = {}): FolderNode {
  return {
    id,
    clientId: `folder-${id}`,
    vaultId: 1,
    keyScopeClientId: 'scope-1',
    name,
    icon: undefined,
    tags: [],
    locked: false,
    permission: 'own',
    keyScopeId: 1,
    keyVersion: 1,
    ownScope: false,
    grantCount: 0,
    updatedAt: AT,
    updatedBy: null,
    parentId: null,
    depth: 0,
    position: 0,
    ...extra,
  };
}

function note(id: number, name: string, extra: Partial<NoteNode> = {}): NoteNode {
  return {
    id,
    clientId: `note-${id}`,
    vaultId: 1,
    keyScopeClientId: 'scope-1',
    name,
    icon: undefined,
    tags: [],
    locked: false,
    permission: 'own',
    keyScopeId: 1,
    keyVersion: 1,
    ownScope: false,
    grantCount: 0,
    updatedAt: AT,
    updatedBy: null,
    folderId: null,
    contentSeq: 1,
    contentSize: 4096,
    ...extra,
  };
}

const vault: Vault = {
  id: 1,
  clientId: 'vault-1',
  keyScopeClientId: 'scope-1',
  name: 'Personal',
  emoji: 'star',
  locked: false,
  role: 'owner',
  keyState: 'ok',
  keyScopeId: 1,
  keyVersion: 1,
  noteCount: 0,
  memberCount: 1,
  changeSeq: 1,
  label: undefined,
};

/** Packs a plan the way the export does, so the two halves are tested against each other. */
async function pack(tree: Tree, bodies: Record<string, string>): Promise<Map<string, Uint8Array>> {
  const plan = planArchive(tree);

  const entries = [
    ...plan.directories.map((path) => ({ path, data: new Uint8Array(0) })),
    ...plan.notes.map((planned) => ({
      path: planned.entry.path,
      data: utf8(bodies[planned.node.name] ?? ''),
    })),
    {
      path: MANIFEST_PATH,
      data: utf8(JSON.stringify(manifest(vault, plan, plan.skipped, new Date(AT)))),
    },
  ];

  return unzip(await (await zip(entries, new Date(AT))).arrayBuffer());
}

describe('a name as a path', () => {
  it('replaces what a file system will not take', () => {
    expect(segment('notes/2026: plans?')).toBe('notes-2026- plans-');
    expect(segment('a\\b"c<d>e|f*g')).toBe('a-b-c-d-e-f-g');
  });

  it('leaves ordinary names alone', () => {
    expect(segment('Планы на 2026 (черновик)')).toBe('Планы на 2026 (черновик)');
    expect(segment('Q4 review — draft #2')).toBe('Q4 review — draft #2');
  });

  it('falls back when nothing usable is left', () => {
    expect(segment('   ')).toBe('Untitled');
    expect(segment('...')).toBe('Untitled');
    // A name that was only separators keeps their shape rather than becoming Untitled: it is
    // still a name, and two of them in one folder still have to differ.
    expect(segment('///')).toBe('---');
  });

  it('keeps Windows from silently renaming the file', () => {
    expect(segment('draft. ')).toBe('draft');
    expect(segment('CON')).toBe('_CON');
    expect(segment('nul.md')).toBe('_nul.md');
    expect(segment('com1')).toBe('_com1');
  });

  it('cuts long names without splitting a character in half', () => {
    expect(segment('a'.repeat(200))).toHaveLength(80);
    expect([...segment('🍎'.repeat(200))]).toHaveLength(80);
  });

  it('keeps siblings apart however the file system folds them', () => {
    const taken = new Set<string>();

    expect(unique(taken, 'Notes', '.md')).toBe('Notes.md');
    expect(unique(taken, 'notes', '.md')).toBe('notes (2).md');
    expect(unique(taken, 'NOTES', '.md')).toBe('NOTES (3).md');
    // Composed and decomposed é are one file on macOS.
    expect(unique(taken, 'café', '')).toBe('café');
    expect(unique(taken, 'café', '')).toBe('café (2)');
  });
});

describe('the archive plan', () => {
  const tree: Tree = {
    folders: [
      folder(1, 'Work', { position: 1 }),
      folder(2, 'Archive', { position: 0 }),
      folder(3, 'Q4', { parentId: 1, depth: 1 }),
    ],
    notes: [
      note(10, 'Kickoff', { folderId: 3 }),
      note(11, 'Inbox'),
      note(12, 'Kickoff', { folderId: 3 }),
    ],
  };

  it('lays folders out in sidebar order, with notes under them', () => {
    const plan = planArchive(tree);

    expect(plan.directories).toEqual(['notes/Archive/', 'notes/Work/', 'notes/Work/Q4/']);
    expect(plan.notes.map((planned) => planned.entry.path)).toEqual([
      'notes/Work/Q4/Kickoff.md',
      'notes/Work/Q4/Kickoff (2).md',
      'notes/Inbox.md',
    ]);
  });

  it('records the real name even where the path could not keep it', () => {
    const plan = planArchive({ folders: [], notes: [note(10, 'and/or: which?')] });

    expect(plan.notes[0]?.entry.path).toBe('notes/and-or- which-.md');
    expect(plan.notes[0]?.entry.name).toBe('and/or: which?');
  });

  it('gives the same archive for the same tree', () => {
    expect(planArchive(tree)).toEqual(planArchive(tree));
  });

  it('leaves out what this reader holds no key for', () => {
    const plan = planArchive({
      folders: [folder(1, '••••••', { locked: true }), folder(2, 'Open')],
      notes: [note(10, 'Buried', { folderId: 1 }), note(11, 'Readable', { folderId: 2 })],
    });

    expect(plan.directories).toEqual(['notes/Open/']);
    expect(plan.notes.map((planned) => planned.node.id)).toEqual([11]);
    // The locked folder takes its note with it: there is no readable folder to file it under.
    expect(plan.skipped).toEqual([
      { kind: 'folder', ref: '1', reason: 'locked' },
      { kind: 'note', ref: '10', reason: 'locked' },
    ]);
  });
});

describe('reading an archive back', () => {
  const tree: Tree = {
    folders: [
      folder(1, 'Work', { icon: 'book', tags: ['work'] }),
      folder(2, 'Empty'),
      folder(3, 'Q4', { parentId: 1, depth: 1 }),
    ],
    notes: [
      note(10, 'Kickoff', { folderId: 3, icon: 'doc', tags: ['work', 'WORK', 'not a tag'] }),
      note(11, 'Inbox'),
    ],
  };

  it('survives the round trip through a real zip', async () => {
    const files = await pack(tree, { Kickoff: '# Kickoff\n\nтекст со #здесь', Inbox: '' });
    const plan = parseArchive(files);

    expect(plan.vault).toEqual({ name: 'Personal', icon: 'star' });
    expect(plan.exportedAt).toBe(AT);

    expect(plan.folders).toEqual([
      { uid: 'folder-1', parent: null, name: 'Work', icon: 'book', tags: ['work'] },
      { uid: 'folder-2', parent: null, name: 'Empty', tags: [] },
      { uid: 'folder-3', parent: 'folder-1', name: 'Q4', tags: [] },
    ]);

    expect(plan.notes).toEqual([
      {
        uid: 'note-10',
        folder: 'folder-3',
        name: 'Kickoff',
        icon: 'doc',
        tags: ['work'],
        body: '# Kickoff\n\nтекст со #здесь',
      },
      { uid: 'note-11', folder: null, name: 'Inbox', tags: [], body: '' },
    ]);
  });

  it('reads an archive somebody unpacked and packed again', async () => {
    const files = await pack(tree, { Kickoff: 'body', Inbox: '' });
    const nested = new Map([...files].map(([path, data]) => [`Personal/${path}`, data]));

    expect(parseArchive(nested).notes.map((note) => note.name)).toEqual(['Kickoff', 'Inbox']);
  });

  it('refuses what it cannot vouch for', () => {
    const write = (body: unknown) => new Map([[MANIFEST_PATH, utf8(JSON.stringify(body))]]);

    expect(() => parseArchive(new Map())).toThrow('not a Shelf archive');
    expect(() => parseArchive(new Map([[MANIFEST_PATH, utf8('{oh no')]]))).toThrow('not readable');
    expect(() => parseArchive(write({ format: 'obsidian' }))).toThrow('not a Shelf archive');
    expect(() =>
      parseArchive(write({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION + 1 })),
    ).toThrow('newer version');
    expect(() => parseArchive(write({ format: ARCHIVE_FORMAT, version: 1 }))).toThrow('incomplete');
  });

  it('keeps what it can and says what it dropped', () => {
    const written: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exported_at: AT,
      vault: { name: 'Personal' },
      folders: [
        { uid: 'a', parent: null, name: 'A', tags: [], position: 0, path: 'notes/A/' },
        { uid: 'b', parent: 'gone', name: 'B', tags: [], position: 0, path: 'notes/B/' },
        { uid: 'c', parent: 'd', name: 'C', tags: [], position: 0, path: 'notes/C/' },
        { uid: 'd', parent: 'c', name: 'D', tags: [], position: 0, path: 'notes/D/' },
      ],
      notes: [
        { uid: 'kept', folder: 'a', name: 'Kept', tags: [], updated_at: AT, path: 'notes/A/k.md' },
        { uid: 'lost', folder: 'b', name: 'Lost', tags: [], updated_at: AT, path: 'notes/B/l.md' },
        { uid: 'gone', folder: null, name: 'Gone', tags: [], updated_at: AT, path: 'notes/g.md' },
      ],
      skipped: [],
    };

    const plan = parseArchive(
      new Map([
        [MANIFEST_PATH, utf8(JSON.stringify(written))],
        ['notes/A/k.md', utf8('kept')],
        ['notes/B/l.md', utf8('lost')],
      ]),
    );

    expect(plan.folders.map((folder) => folder.uid)).toEqual(['a']);
    // A note whose folder went is kept at the root rather than thrown away with it.
    expect(plan.notes.map((note) => [note.uid, note.folder])).toEqual([
      ['kept', 'a'],
      ['lost', null],
    ]);
    expect(plan.skipped).toEqual([
      { kind: 'folder', ref: 'b', reason: 'orphaned' },
      // c and d name each other as parents, which is a loop rather than a chain.
      { kind: 'folder', ref: 'c', reason: 'orphaned' },
      { kind: 'folder', ref: 'd', reason: 'orphaned' },
      { kind: 'note', ref: 'gone', reason: 'missing' },
    ]);
  });

  it('takes only what the app can show', () => {
    const written = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exported_at: AT,
      vault: { name: '   ', icon: 'not-an-icon' },
      folders: [],
      notes: [
        {
          uid: 'n',
          folder: null,
          name: 'x'.repeat(400),
          icon: '<script>',
          tags: ['Work', '#work', 'спорт', 'no good', ...Array.from({ length: 40 }, (_, i) => `t${i}`)],
          updated_at: AT,
          path: 'n.md',
        },
      ],
      skipped: [],
    };

    const plan = parseArchive(
      new Map([
        [MANIFEST_PATH, utf8(JSON.stringify(written))],
        ['n.md', utf8('body')],
      ]),
    );

    expect(plan.vault).toEqual({ name: 'Untitled' });
    expect(plan.notes[0]?.name).toHaveLength(200);
    expect(plan.notes[0]).not.toHaveProperty('icon');
    expect(plan.notes[0]?.tags).toHaveLength(24);
    expect(plan.notes[0]?.tags.slice(0, 3)).toEqual(['work', 'спорт', 't0']);
  });
});

describe('the archive file name', () => {
  it('names the file after the vault and the day', () => {
    expect(archiveFilename('Personal', new Date(AT))).toBe('shelf-personal-2026-08-17.zip');
    expect(archiveFilename('Work / Notes!', new Date(AT))).toBe('shelf-work-notes-2026-08-17.zip');
  });

  it('still names something when the vault name is all symbols', () => {
    expect(archiveFilename('••••••', new Date(AT))).toBe('shelf-2026-08-17.zip');
  });
});
