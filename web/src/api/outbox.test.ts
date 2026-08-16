import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateKey } from '@/crypto/aead';
import { fromUtf8 } from '@/crypto/bytes';
import { ScopeKeyring } from '@/crypto/keyring';

import { OfflineError } from './client';
import { type NoteNode, sealNote, sendNote } from './workspace';

/**
 * Losing the network used to lose the write: the error was swallowed and the note was
 * marked clean. These pin the two halves that make the outbox possible — sealing without
 * sending, so what waits in IndexedDB is ciphertext, and sending a payload that was sealed
 * some time earlier.
 */

const SCOPE = { id: 3, clientId: 'ba5eba11-0000-4000-8000-000000000001', version: 2 };

let sent: Array<{ path: string; body: Record<string, unknown>; ifMatch?: string | undefined }> = [];
let offline = false;

beforeEach(() => {
  sent = [];
  offline = false;

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));

    sent.push({
      path: String(url),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      ifMatch: (init.headers as Record<string, string>)['If-Match'],
    });

    return Promise.resolve(
      new Response(JSON.stringify({ content_seq: 9 }), {
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
    keyScopeClientId: SCOPE.clientId,
    keyScopeId: SCOPE.id,
    keyVersion: SCOPE.version,
    name: 'Roadmap',
    locked: false,
    permission: 'edit',
  } as unknown as NoteNode;
}

describe('the offline outbox', () => {
  it('seals a body without sending it', async () => {
    const payload = await sealNote(note(), 'ship on tuesday', 4, await keyring());

    expect(sent).toHaveLength(0);
    expect(payload.key_scope_id).toBe(SCOPE.id);
    expect(payload.key_version).toBe(SCOPE.version);

    // What waits in IndexedDB has to be ciphertext: a queued write is stored on the same
    // device as the cache, and the rule there is that nothing readable is kept.
    expect(fromUtf8(new Uint8Array(atob(payload.content).split('').map((c) => c.charCodeAt(0)))))
      .not.toContain('tuesday');
  });

  it('sends a payload sealed earlier, under the sequence it was sealed for', async () => {
    const payload = await sealNote(note(), 'ship on tuesday', 4, await keyring());

    const next = await sendNote(88, payload, 4);

    expect(next).toBe(9);
    expect(sent[0]?.ifMatch).toBe('4');
    expect(sent[0]?.body).toMatchObject({
      key_scope_id: SCOPE.id,
      key_version: SCOPE.version,
    });
  });

  it('reports a lost network as something to retry rather than as a failed write', async () => {
    const payload = await sealNote(note(), 'ship on tuesday', 4, await keyring());

    offline = true;

    // OfflineError is what the store branches on to queue instead of discarding; anything
    // else would be reported to the user and the text would be gone.
    await expect(sendNote(88, payload, 4)).rejects.toBeInstanceOf(OfflineError);
  });
});
