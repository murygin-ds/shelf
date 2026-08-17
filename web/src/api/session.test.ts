import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bytesToB64 } from '@/crypto/bytes';
import { DEFAULT_KDF_PARAMS } from '@/crypto/kdf';

import { unlock } from './auth';
import { api, clearSession, storeTokens } from './client';
import type { Tokens } from './types';

/**
 * What the client does with the single-use refresh token. The server revokes every session
 * of the account when a token is presented twice, so "two tabs reloaded together" is not a
 * rare race to shrug off: it signs the user out everywhere.
 */

interface Sent {
  path: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

let sent: Sent[] = [];
let store: Record<string, string> = {};
/** Runs before the callback the lock holder passes, standing in for another tab's exchange. */
let beforeLock: (() => void) | null = null;

const tokens = (n: number): Tokens => ({
  token_type: 'Bearer',
  access_token: `access-${n}`,
  access_expires_at: new Date(Date.now() + 900_000).toISOString(),
  refresh_token: `refresh-${n}`,
  refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers 401 until the request carries a token issued by the refresh endpoint. */
function serve(protectedBody: unknown = { ok: true }) {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const path = String(url);

    sent.push({
      path,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      authorization: headers.Authorization,
    });

    if (path.endsWith('/auth/refresh')) return Promise.resolve(json(tokens(2)));

    return Promise.resolve(
      headers.Authorization === 'Bearer access-2'
        ? json(protectedBody)
        : json({ error: { code: 'unauthorized', message: 'no' } }, 401),
    );
  });
}

beforeEach(() => {
  sent = [];
  store = {};
  beforeLock = null;

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  });

  vi.stubGlobal('navigator', {
    onLine: true,
    locks: {
      request: async (_name: string, run: () => Promise<void>) => {
        beforeLock?.();

        return run();
      },
    },
  });

  serve();
});

afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
});

describe('the refresh token', () => {
  it('is exchanged once for a burst of requests that all see 401', async () => {
    storeTokens(tokens(1), 'ada@example.com');

    await Promise.all([api.get('/auth/me'), api.get('/auth/keys'), api.get('/vaults')]);

    expect(sent.filter((call) => call.path.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('is exchanged before the first request when a reload left no access token', async () => {
    store['shelf.session'] = JSON.stringify({
      refreshToken: 'refresh-1',
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      login: 'ada@example.com',
    });

    await api.get('/vaults');

    // No 401 round trip: the exchange comes first and the vault read carries the new token.
    expect(sent.map((call) => call.path.replace('/api/v1', ''))).toEqual([
      '/auth/refresh',
      '/vaults',
    ]);
    expect(sent[1]?.authorization).toBe('Bearer access-2');
  });

  it('is read inside the lock, so a tab that waited spends the pair the winner stored', async () => {
    storeTokens(tokens(1), 'ada@example.com');

    // While this tab waits its turn, another one exchanges refresh-1 and stores refresh-9.
    beforeLock = () => {
      store['shelf.session'] = JSON.stringify({
        refreshToken: 'refresh-9',
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        login: 'ada@example.com',
      });
    };

    await api.get('/vaults');

    const exchange = sent.find((call) => call.path.endsWith('/auth/refresh'));

    // Presenting refresh-1 here is what revokes every session of the account.
    expect(exchange?.body.refresh_token).toBe('refresh-9');
  });
});

describe('unlocking a session that survived a reload', () => {
  it('reads the account only after the wrapped key opens', async () => {
    storeTokens(tokens(2), 'ada@example.com');

    // Bytes that will not decrypt under any passphrase, which is what a wrong one looks like.
    serve({
      kdf_salt: bytesToB64(new Uint8Array(16)),
      kdf_params: DEFAULT_KDF_PARAMS,
      wrapped_master_key: bytesToB64(new Uint8Array(48)),
      master_key_nonce: bytesToB64(new Uint8Array(12)),
      public_key: bytesToB64(new Uint8Array(32)),
      wrapped_private_key: bytesToB64(new Uint8Array(48)),
      private_key_nonce: bytesToB64(new Uint8Array(12)),
    });

    await expect(unlock('not the passphrase')).rejects.toBeInstanceOf(DOMException);

    const paths = sent.map((call) => call.path.replace('/api/v1', ''));

    expect(paths).toContain('/auth/keys');
    expect(paths).not.toContain('/auth/me');
  });
});
