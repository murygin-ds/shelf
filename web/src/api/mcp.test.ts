import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64 } from '@/crypto/bytes';
import { sealInfo } from '@/crypto/envelope';
import { generateIdentity } from '@/crypto/identity';
import { ScopeKeyring } from '@/crypto/keyring';
import { open } from '@/crypto/sealedbox';

import * as mcp from './mcp';
import type { Vault } from './workspace';

/**
 * The connector's key travels the same sealed box a member's does, and the half that opens it
 * lives in Go. These tests hold the browser end to the shape that other end reads: the right
 * scope named in the seal, the key it actually unwraps to, and nothing sent for a scope the
 * connector was not meant to reach.
 */

const SCOPE_CLIENT_ID = 'a1c9f2e4-7b6d-4f38-9a52-0e3d8c17b4f6';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fixture() {
  const identity = (await generateIdentity(await generateKey())).identity;
  const scopeKey = await generateKey();

  const keyring = new ScopeKeyring();
  keyring.add(11, 2, scopeKey);

  const vault = {
    id: 7,
    keyScopeId: 11,
    keyVersion: 2,
    keyScopeClientId: SCOPE_CLIENT_ID,
  } as unknown as Vault;

  return { identity, scopeKey, keyring, vault };
}

describe('enabling a connector', () => {
  it('seals the vault key so that the holder of the identity can open it', async () => {
    const { identity, scopeKey, keyring, vault } = await fixture();

    const posted: Record<string, unknown>[] = [];

    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      posted.push({ url, body });

      const connector = {
        vault_id: 7,
        user_id: 42,
        public_key: bytesToB64(identity.publicBlob),
        fingerprint: 'NFX3 V6FY TMS2 M6S9',
        role: 'editor',
        key_state: String(url).endsWith('/identity') ? 'pending_key' : 'ok',
        ready: !String(url).endsWith('/identity'),
        created_at: new Date().toISOString(),
      };

      return new Response(JSON.stringify(connector), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const connector = await mcp.enable(vault, 'editor', keyring);

    expect(connector.ready).toBe(true);
    expect(connector.fingerprint).toBe('NFX3 V6FY TMS2 M6S9');

    // Two requests, in that order: the identity cannot be sealed to before it exists.
    expect(posted).toHaveLength(2);
    expect(String(posted[0]?.url)).toContain('/mcp/identity');
    expect(String(posted[1]?.url)).toMatch(/\/vaults\/7\/mcp$/);

    const keys = (posted[1]?.body as { keys: Record<string, string | number>[] }).keys;

    expect(keys).toHaveLength(1);
    expect(keys[0]?.scope_id).toBe(11);
    expect(keys[0]?.key_version).toBe(2);
    expect(keys[0]?.wrap_algorithm).toBe('ecdh-p256-hkdf-a256gcm');

    // The half that matters: it has to open, under the info string naming this scope and
    // version, back to the very key the keyring holds.
    const opened = await open(
      identity.sealPrivate,
      {
        blob: b64ToBytes(String(keys[0]?.wrapped_key)),
        nonce: b64ToBytes(String(keys[0]?.nonce)),
      },
      sealInfo(SCOPE_CLIENT_ID, 2),
    );

    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', scopeKey));

    expect(bytesToB64(opened)).toBe(bytesToB64(raw));
  });

  it('will not seal a key it does not hold', async () => {
    const { identity, vault } = await fixture();

    const called: string[] = [];

    vi.stubGlobal('fetch', async (url: string) => {
      called.push(String(url));

      return new Response(
        JSON.stringify({
          vault_id: 7,
          user_id: 42,
          public_key: bytesToB64(identity.publicBlob),
          fingerprint: 'x',
          role: 'editor',
          key_state: 'pending_key',
          ready: false,
          created_at: new Date().toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    // A keyring with nothing in it is what a locked vault looks like. Handing the server a
    // grant it could not have produced is worse than refusing.
    await expect(mcp.enable(vault, 'editor', new ScopeKeyring())).rejects.toBeInstanceOf(Error);

    // What the refusal has to mean, rather than what it says: the identity was minted and
    // nothing was sealed to it. The sentence in the error is written for a log.
    expect(called.filter((url) => !url.endsWith('/identity'))).toEqual([]);
  });

  it('binds the seal to the scope, so it cannot be replayed into another', async () => {
    const { identity, keyring, vault } = await fixture();

    let sealed: Record<string, string> | null = null;

    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!String(url).endsWith('/identity')) {
        const body = JSON.parse(String(init.body)) as { keys: Record<string, string>[] };
        sealed = body.keys[0] ?? null;
      }

      return new Response(
        JSON.stringify({
          vault_id: 7,
          user_id: 42,
          public_key: bytesToB64(identity.publicBlob),
          fingerprint: 'x',
          role: 'editor',
          key_state: 'ok',
          ready: true,
          created_at: new Date().toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await mcp.enable(vault, 'editor', keyring);

    expect(sealed).not.toBeNull();

    const box = {
      blob: b64ToBytes(String(sealed!.wrapped_key)),
      nonce: b64ToBytes(String(sealed!.nonce)),
    };

    await expect(open(identity.sealPrivate, box, sealInfo(SCOPE_CLIENT_ID, 3))).rejects.toThrow();
    await expect(
      open(identity.sealPrivate, box, sealInfo('00000000-0000-4000-8000-000000000000', 2)),
    ).rejects.toThrow();
  });

  // The connector is off by default and its routes are not mounted when it is. Asking first
  // is what keeps the wizard from making a vault it then cannot connect.
  it('asks the server whether a connector can be served at all', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ connector: true, realtime: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(mcp.available()).resolves.toBe(true);

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ connector: false, realtime: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(mcp.available()).resolves.toBe(false);

    // A server too old to have the document has no connector either.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));

    await expect(mcp.available()).resolves.toBe(false);
  });

  it('treats a vault with no connector as a state rather than a failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));

    await expect(mcp.connector(7)).resolves.toBeNull();
  });
});
