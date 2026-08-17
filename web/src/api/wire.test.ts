import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateKey } from '@/crypto/aead';
import { DEFAULT_KDF_PARAMS } from '@/crypto/kdf';
import { ScopeKeyring } from '@/crypto/keyring';

import { deleteAccount, updateDisplayName } from './auth';
import { createFolder, createNote, type NoteNode, writeNote } from './workspace';

/**
 * The request bodies this client sends, checked against the fields the server marks
 * required in internal/api/v1/vault/dto.go.
 *
 * These exist because a field added to a Go DTO and forgotten here fails at validation
 * rather than at compile time: the client keeps building, the server answers 422, and the
 * only thing that notices is a user who cannot save. That is exactly what happened when
 * the content write gained its key-version lock.
 */

const SCOPE = { id: 3, clientId: 'ba5eba11-0000-4000-8000-000000000001', version: 2 };

interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

let sent: Sent[] = [];

beforeEach(async () => {
  sent = [];

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({
      path: String(url),
      method: init.method ?? 'GET',
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    return Promise.resolve(
      new Response(JSON.stringify({ id: 1, content_seq: 4, client_id: 'x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function keyring(): Promise<ScopeKeyring> {
  const ring = new ScopeKeyring();
  ring.add(SCOPE.id, SCOPE.version, await generateKey());

  return ring;
}

function note(): NoteNode {
  return {
    id: 88,
    clientId: '8f14e45f-ceea-467a-9f6b-1d2c3b4a5e60',
    vaultId: 12,
    keyScopeClientID: SCOPE.clientId,
    keyScopeClientId: SCOPE.clientId,
    name: 'Roadmap',
    locked: false,
    permission: 'edit',
    keyScopeId: SCOPE.id,
    keyVersion: SCOPE.version,
    ownScope: false,
    grantCount: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    folderId: null,
    contentSeq: 3,
    contentSize: 4112,
  } as unknown as NoteNode;
}

describe('request bodies match the server DTOs', () => {
  it('a content write names the key it sealed under', async () => {
    // The server marks key_scope_id and key_version required precisely so a write that
    // started before a re-key cannot land under the new version. Omitting them is a 422,
    // which is to say: no note can be saved at all.
    await writeNote(note(), 'ship on tuesday', 3, await keyring());

    const [put] = sent;

    expect(put?.method).toBe('PUT');
    expect(put?.path).toContain('/files/88/content');
    expect(put?.headers['If-Match']).toBe('3');

    for (const field of ['content', 'content_nonce', 'key_scope_id', 'key_version']) {
      expect(put?.body).toHaveProperty(field);
    }

    expect(put?.body.key_scope_id).toBe(SCOPE.id);
    expect(put?.body.key_version).toBe(SCOPE.version);
  });

  it('a new folder names its scope', async () => {
    // The fake response is not a real folder, so opening it fails — which is fine: the
    // request went out before that, and the request is what this test is about.
    await createFolder(12, null, 'Product', SCOPE, await keyring()).catch(() => undefined);

    const [post] = sent;

    for (const field of ['client_id', 'meta', 'meta_nonce', 'key_scope_id', 'key_version']) {
      expect(post?.body).toHaveProperty(field);
    }
  });

  it('a new note names its scope and carries a body', async () => {
    await createNote(12, null, 'Roadmap', SCOPE, await keyring()).catch(() => undefined);

    const [post] = sent;

    for (const field of [
      'client_id',
      'meta',
      'meta_nonce',
      'content',
      'content_nonce',
      'key_scope_id',
      'key_version',
    ]) {
      expect(post?.body).toHaveProperty(field);
    }
  });

  it('a body is padded, so its stored size is not a fingerprint of the text', async () => {
    await writeNote(note(), 'x', 3, await keyring());

    const ciphertext = atob(String(sent[0]?.body.content));

    // 4 KiB of padding plus the GCM tag. A one-character note and a full page look alike.
    expect(ciphertext.length).toBeGreaterThanOrEqual(4096);
  });
});

describe('account requests', () => {
  it('sends the display name the profile endpoint asks for', async () => {
    await updateDisplayName('Dmitry M.');

    expect(sent[0]).toMatchObject({ method: 'PATCH', body: { display_name: 'Dmitry M.' } });
  });

  it('proves the passphrase before it asks for a deletion', async () => {
    // The stored session is dropped on the way out, and this environment has no storage.
    const store: Record<string, string> = {};

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    });

    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      sent.push({
        path: String(url),
        method: init.method ?? 'GET',
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        headers: (init.headers ?? {}) as Record<string, string>,
      });

      return Promise.resolve(
        new Response(
          JSON.stringify({
            kdf_salt: btoa('0123456789abcdef'),
            kdf_params: DEFAULT_KDF_PARAMS,
            wrapped_master_key: '',
            master_key_nonce: '',
            public_key: '',
            wrapped_private_key: '',
            private_key_nonce: '',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    await deleteAccount('correct horse battery staple');

    const [keys, deletion] = sent;

    // The salt has to come from the account before anything can be derived with it.
    expect(keys).toMatchObject({ method: 'GET' });
    expect(keys?.path).toContain('/auth/keys');
    expect(deletion).toMatchObject({ method: 'DELETE' });
    expect(deletion?.path).toContain('/auth/me');
    expect(typeof deletion?.body.auth_hash).toBe('string');
    // The passphrase itself never travels.
    expect(JSON.stringify(deletion?.body)).not.toContain('correct horse');
  });
});
