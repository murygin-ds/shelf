import { create } from 'zustand';

import * as authApi from '@/api/auth';
import { ApiError, clearSession, hasAccessToken, readSession, setSessionLostHandler } from '@/api/client';
import { ErrorCode, type User } from '@/api/types';
import type { Identity } from '@/crypto/identity';

/**
 * anonymous — no session at all.
 * locked    — the refresh token survived a reload but the master key did not, so the
 *             passphrase has to be entered again. This is the "KEY UNLOCKED" indicator.
 * kit       — keys are ready, but a freshly issued recovery code has not been acknowledged.
 *             It is a state of its own so that no redirect can skip past the one screen
 *             where that code is ever shown.
 * unlocked  — keys are in memory and the vaults can be read.
 */
export type SessionStatus = 'anonymous' | 'locked' | 'kit' | 'unlocked';

interface SessionState {
  status: SessionStatus;
  user: User | null;
  identity: Identity | null;
  masterKey: CryptoKey | null;
  /** Remembered across a reload so the unlock screen can prefill it. */
  knownLogin: string | null;
  /** Held only until the user confirms they stored it. Never persisted. */
  pendingRecoveryCode: string | null;
  busy: boolean;
  error: string | null;

  signIn: (login: string, passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  register: (input: authApi.RegisterInput) => Promise<void>;
  recover: (login: string, code: string, passphrase: string) => Promise<void>;
  acknowledgeKit: () => void;
  signOut: () => Promise<void>;
  lock: () => void;
  clearError: () => void;
}

function initialStatus(): SessionStatus {
  return readSession() ? 'locked' : 'anonymous';
}

export const useSession = create<SessionState>((set, get) => ({
  status: initialStatus(),
  user: null,
  identity: null,
  masterKey: null,
  knownLogin: readSession()?.login ?? null,
  pendingRecoveryCode: null,
  busy: false,
  error: null,

  signIn: async (login, passphrase) => {
    await run(set, async () => {
      const session = await authApi.signIn(login, passphrase);
      set({ ...session, status: 'unlocked', knownLogin: session.user.login });
    });
  },

  unlock: async (passphrase) => {
    await run(set, async () => {
      const session = await authApi.unlock(passphrase);
      set({ ...session, status: 'unlocked', knownLogin: session.user.login });
    });
  },

  register: async (input) => {
    await run(set, async () => {
      const { session, recoveryCode } = await authApi.register(input);

      set({
        ...session,
        status: 'kit',
        knownLogin: session.user.login,
        pendingRecoveryCode: recoveryCode,
      });
    });
  },

  recover: async (login, code, passphrase) => {
    await run(set, async () => {
      const challenge = await authApi.startRecovery(login, code);
      const { recoveryCode } = await authApi.completeRecovery(login, challenge, passphrase);

      // The reset revoked every session, and the new pair is already stored, so the
      // fastest way to a consistent state is to derive the keys from the new passphrase.
      const session = await authApi.unlock(passphrase);

      set({
        ...session,
        status: 'kit',
        knownLogin: session.user.login,
        pendingRecoveryCode: recoveryCode,
      });
    });
  },

  acknowledgeKit: () => set({ status: 'unlocked', pendingRecoveryCode: null }),

  signOut: async () => {
    await authApi.signOut().catch(() => undefined);

    set({
      status: 'anonymous',
      user: null,
      identity: null,
      masterKey: null,
      pendingRecoveryCode: null,
      error: null,
    });
  },

  lock: () => {
    // Drops the keys but keeps the session, which is what a manual lock should do.
    // Locking while a kit is pending would strand the code, so it is refused.
    if (get().status === 'kit') return;

    set({ status: get().user ? 'locked' : 'anonymous', identity: null, masterKey: null });
  },

  clearError: () => set({ error: null }),
}));

setSessionLostHandler(() => {
  clearSession();

  useSession.setState({
    status: 'anonymous',
    user: null,
    identity: null,
    masterKey: null,
    pendingRecoveryCode: null,
  });
});

type Setter = (partial: Partial<SessionState>) => void;

async function run(set: Setter, action: () => Promise<void>): Promise<void> {
  set({ busy: true, error: null });

  try {
    await action();
  } catch (cause) {
    set({ error: describe(cause) });
    throw cause;
  } finally {
    set({ busy: false });
  }
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case ErrorCode.Unauthorized:
        return 'Wrong login or passphrase.';
      case ErrorCode.Conflict:
        return 'That address is already registered.';
      case ErrorCode.TooManyRequests:
        return cause.retryAfter
          ? `Too many attempts. Try again in ${Math.ceil(cause.retryAfter / 60)} min.`
          : 'Too many attempts. Try again later.';
      case ErrorCode.Validation:
        return 'The server rejected the request as invalid.';
      default:
        return cause.message;
    }
  }

  // Decryption is the other way in: a wrong passphrase passes the server check only when
  // the wrapped key does not open, which surfaces as an OperationError from WebCrypto.
  if (cause instanceof DOMException) return 'Could not decrypt your keys with that passphrase.';

  if (cause instanceof Error) return cause.message;

  return 'Something went wrong.';
}

/** True when a request would be sent with a bearer token already in hand. */
export function isAuthenticated(): boolean {
  return hasAccessToken() || readSession() !== null;
}
