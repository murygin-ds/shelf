import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportKey, generateKey } from '@/crypto/aead';
import { bytesToB64 } from '@/crypto/bytes';
import { encryptContent, encryptMeta, sealInfo } from '@/crypto/envelope';
import { generateIdentity, splitPublicBlob, type Identity } from '@/crypto/identity';
import { ScopeKeyring } from '@/crypto/keyring';
import { seal } from '@/crypto/sealedbox';
import { MANIFEST_PATH, type ImportPlan } from '@/lib/archive';
import { unzip } from '@/lib/zip';

import { exportVault, importVault } from './transfer';
import type { FileDto, NoteNode, Tree, Vault } from './workspace';

/**
 * The two halves of a transfer against a stubbed server.
 *
 * What is worth pinning here is the order and the identity of things: a folder has to exist
 * before the note that names it, and nothing an archive carries may be reused as an id —
 * every ciphertext is bound to the slot it lives in, and these slots are new.
 */

const SCOPE = { id: 1, clientId: 'ba5eba11-0000-4000-8000-00000000c0de', version: 1 };
const VAULT_ID = 7;

let identity: Identity;
let key: CryptoKey;
let keyring: ScopeKeyring;
let calls: Array<{ method: string; path: string; body: Body; ifMatch: string | undefined }>;
let ids: number;

type Body = Record<string, unknown>;

const vault: Vault = {
  id: VAULT_ID,
  clientId: 'f1e2d3c4-0000-4000-8000-000000000001',
  keyScopeClientId: SCOPE.clientId,
  name: 'Personal',
  emoji: undefined,
  locked: false,
  role: 'owner',
  keyState: 'ok',
  keyScopeId: SCOPE.id,
  keyVersion: SCOPE.version,
  noteCount: 2,
  memberCount: 1,
  changeSeq: 1,
  label: undefined,
};

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/** Echoes what the client sealed, the way the server does, plus the ids it assigns. */
function created(body: Body, extra: Body = {}): Body {
  ids += 1;

  return {
    id: ids,
    client_id: body.client_id,
    vault_id: VAULT_ID,
    key_scope_id: SCOPE.id,
    key_scope_client_id: SCOPE.clientId,
    key_version: SCOPE.version,
    meta: body.meta,
    meta_nonce: body.meta_nonce,
    inherit_access: true,
    permission: 'own',
    own_scope: false,
    grant_count: 0,
    updated_seq: ids,
    updated_by: null,
    deleted_at: null,
    updated_at: '2026-08-17T10:00:00Z',
    ...extra,
  };
}

beforeEach(async () => {
  calls = [];
  ids = 100;

  identity = (await generateIdentity(await generateKey())).identity;
  key = await generateKey();
  keyring = new ScopeKeyring();
  keyring.add(SCOPE.id, SCOPE.version, key);

  const box = await seal(
    splitPublicBlob(identity.publicBlob).seal,
    await exportKey(key),
    sealInfo(SCOPE.clientId, SCOPE.version),
  );

  const sealedMeta = await encryptMeta(
    key,
    { name: 'Restored' },
    {
      vaultId: 0,
      entity: 'vault',
      entityId: vault.clientId,
      scopeClientId: SCOPE.clientId,
      keyVersion: SCOPE.version,
    },
  );

  const summary = {
    id: VAULT_ID,
    client_id: vault.clientId,
    key_scope_client_id: SCOPE.clientId,
    owner_id: 1,
    meta: bytesToB64(sealedMeta.ciphertext),
    meta_nonce: bytesToB64(sealedMeta.nonce),
    change_seq: 1,
    role: 'owner',
    key_state: 'ok',
    key_scope_id: SCOPE.id,
    key_version: SCOPE.version,
    note_count: 0,
    member_count: 1,
  };

  const grants = [
    {
      scope_id: SCOPE.id,
      scope_client_id: SCOPE.clientId,
      key_version: SCOPE.version,
      subject_type: 'user',
      subject_id: 1,
      wrapped_key: bytesToB64(box.blob),
      nonce: bytesToB64(box.nonce),
      wrap_algorithm: 'ecdh-p256-hkdf-a256gcm',
    },
  ];

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = String(url).replace('/api/v1', '');
    const body = init.body ? (JSON.parse(String(init.body)) as Body) : {};

    calls.push({
      method,
      path,
      body,
      ifMatch: (init.headers as Record<string, string> | undefined)?.['If-Match'],
    });

    if (method === 'POST' && path === '/vaults') return json({ id: VAULT_ID });
    if (method === 'GET' && path === '/vaults') return json({ vaults: [summary] });
    if (path.endsWith('/group-keys')) return json({ keys: [] });
    if (path.endsWith('/keys')) return json({ grants });
    if (path.endsWith('/folders')) return json(created(body, { parent_id: body.parent_id, depth: 0, position: 0 }));

    if (path.endsWith('/files')) {
      return json(
        created(body, {
          folder_id: body.folder_id,
          content: body.content,
          content_nonce: body.content_nonce,
          content_seq: 1,
          content_size: 4096,
        }),
      );
    }

    if (path.endsWith('/content')) return json({ content_seq: 2 });

    return json({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function note(id: number, name: string, extra: Partial<NoteNode> = {}): NoteNode {
  return {
    id,
    clientId: `note-${id}`,
    vaultId: VAULT_ID,
    keyScopeClientId: SCOPE.clientId,
    keyScopeId: SCOPE.id,
    keyVersion: SCOPE.version,
    name,
    icon: undefined,
    tags: [],
    locked: false,
    permission: 'own',
    ownScope: false,
    grantCount: 0,
    updatedAt: '2026-08-17T10:00:00Z',
    updatedBy: null,
    folderId: null,
    contentSeq: 1,
    contentSize: 4096,
    ...extra,
  };
}

/** A body sealed the way the server holds it, so the export has something real to open. */
async function body(node: NoteNode, text: string): Promise<FileDto> {
  const sealed = await encryptContent(key, text, {
    vaultId: VAULT_ID,
    entity: 'file',
    entityId: node.clientId,
    scopeClientId: SCOPE.clientId,
    keyVersion: SCOPE.version,
  });

  return {
    id: node.id,
    client_id: node.clientId,
    vault_id: VAULT_ID,
    key_scope_id: SCOPE.id,
    key_scope_client_id: SCOPE.clientId,
    key_version: SCOPE.version,
    content: bytesToB64(sealed.ciphertext),
    content_nonce: bytesToB64(sealed.nonce),
  } as unknown as FileDto;
}

describe('exporting a vault', () => {
  it('writes the tree it could read, and says what it could not', async () => {
    const tree: Tree = {
      folders: [],
      notes: [note(1, 'Kickoff'), note(2, 'Locked', { locked: true }), note(3, 'Purged')],
    };

    const bodies = [await body(note(1, 'Kickoff'), '# Kickoff')];

    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const path = String(url).replace('/api/v1', '');
      const asked = init.body ? (JSON.parse(String(init.body)) as { ids: number[] }) : { ids: [] };

      calls.push({ method: 'POST', path, body: asked as unknown as Body, ifMatch: undefined });

      // Note 3 answers nothing: it was purged between the tree and this request.
      return json({ files: bodies.filter((file) => asked.ids.includes(file.id)) });
    });

    const result = await exportVault(vault, tree, keyring);
    const files = await unzip(await result.blob.arrayBuffer());

    expect(calls.map((call) => call.path)).toEqual([`/vaults/${VAULT_ID}/files/bulk`]);
    // The locked note is never asked for: there is no key to open it with.
    expect((calls[0]?.body as unknown as { ids: number[] }).ids).toEqual([1, 3]);

    expect([...files.keys()]).toEqual(['notes/Kickoff.md', MANIFEST_PATH]);
    expect(result.notes).toBe(1);
    expect(result.skipped).toEqual([
      { kind: 'note', ref: '2', reason: 'locked' },
      { kind: 'note', ref: '3', reason: 'missing' },
    ]);
  });

  it('asks for bodies in pages the server will accept', async () => {
    const notes = Array.from({ length: 201 }, (_, i) => note(i + 1, `Note ${i + 1}`));
    const bodies = await Promise.all(notes.map((node) => body(node, 'text')));

    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const asked = JSON.parse(String(init.body)) as { ids: number[] };
      calls.push({ method: 'POST', path: String(url), body: asked as unknown as Body, ifMatch: undefined });

      return json({ files: bodies.filter((file) => asked.ids.includes(file.id)) });
    });

    const seen: number[] = [];
    const result = await exportVault({ ...vault }, { folders: [], notes }, keyring, (progress) =>
      seen.push(progress.done),
    );

    expect(calls.map((call) => (call.body as unknown as { ids: number[] }).ids.length)).toEqual([
      200, 1,
    ]);
    expect(result.notes).toBe(201);
    expect(seen).toEqual([0, 200, 201]);
  });
});

describe('importing an archive', () => {
  const plan: ImportPlan = {
    vault: { name: 'Restored' },
    exportedAt: '2026-08-17T10:00:00.000Z',
    folders: [
      { uid: 'work', parent: null, name: 'Work', tags: [] },
      { uid: 'q4', parent: 'work', name: 'Q4', icon: 'book', tags: ['plans'] },
    ],
    notes: [
      { uid: 'kickoff', folder: 'q4', name: 'Kickoff', tags: [], body: 'see [[Inbox]]' },
      { uid: 'inbox', folder: null, name: 'Inbox', tags: [], body: '' },
    ],
    skipped: [],
  };

  it('creates the vault, then folders, then notes under them', async () => {
    const report = await importVault(plan, 'Restored', identity);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /vaults',
      'GET /vaults',
      `GET /vaults/${VAULT_ID}/keys`,
      `GET /vaults/${VAULT_ID}/group-keys`,
      `GET /vaults/${VAULT_ID}/keys`,
      `GET /vaults/${VAULT_ID}/group-keys`,
      `POST /vaults/${VAULT_ID}/folders`,
      `POST /vaults/${VAULT_ID}/folders`,
      'PATCH /folders/102',
      `POST /vaults/${VAULT_ID}/files`,
      'PUT /files/103/content',
      `POST /vaults/${VAULT_ID}/files`,
      'PUT /files/103/links',
    ]);

    // The link is recorded on the note that carries the text, pointing at the note it names.
    expect(calls.at(-1)?.body).toEqual({ to: [104] });

    const folders = calls.filter((call) => call.path.endsWith('/folders'));
    const notes = calls.filter((call) => call.path.endsWith('/files'));

    // The child folder names its parent by the id the server just handed out.
    expect(folders[0]?.body.parent_id).toBeNull();
    expect(folders[1]?.body.parent_id).toBe(101);
    expect(notes[0]?.body.folder_id).toBe(102);
    expect(notes[1]?.body.folder_id).toBeNull();

    expect(report).toMatchObject({ vaultId: VAULT_ID, folders: 2, notes: 2, failures: [] });
  });

  it('never reuses an id the archive carried', async () => {
    await importVault(plan, 'Restored', identity);

    const written = calls
      .filter((call) => call.method === 'POST' && call.path.includes('/vaults/'))
      .map((call) => call.body.client_id);

    expect(written).toHaveLength(4);
    for (const clientId of written) {
      expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(['work', 'q4', 'kickoff', 'inbox']).not.toContain(clientId);
    }
  });

  it('writes a body under the lock the note was created with', async () => {
    await importVault(plan, 'Restored', identity);

    const write = calls.find((call) => call.path.endsWith('/content'));

    expect(write?.ifMatch).toBe('1');
    expect(write?.body).toMatchObject({ key_scope_id: SCOPE.id, key_version: SCOPE.version });
    // Signed, because a reader cannot tell an authored body from an invented one otherwise.
    expect(write?.body.signature).toEqual(expect.any(String));
    // The empty note is created and left alone: there is nothing to write.
    expect(calls.filter((call) => call.path.endsWith('/content'))).toHaveLength(1);
  });

  it('only rewrites meta for a node that carries an icon or tags', async () => {
    await importVault(plan, 'Restored', identity);

    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.path)).toEqual([
      '/folders/102',
    ]);
  });

  it('keeps going when one note fails, and reports it', async () => {
    let files = 0;

    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      if (String(url).endsWith('/files') && (init.method ?? 'GET') === 'POST') {
        files += 1;
        if (files === 1) return json({ error: { code: 'internal_error', message: 'nope' } });
      }

      return inner(url, init) as Promise<Response>;
    });

    const report = await importVault(plan, 'Restored', identity);

    expect(report.notes).toBe(1);
    expect(report.failures).toEqual([
      { kind: 'note', name: 'Kickoff', message: expect.any(String) },
    ]);
  });
});
