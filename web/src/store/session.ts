import { create } from 'zustand';

import * as authApi from '@/api/auth';
import { ApiError, clearSession, hasAccessToken, readSession, setSessionLostHandler } from '@/api/client';
import { ErrorCode, type User } from '@/api/types';
import type { Identity } from '@/crypto/identity';
import { dropAll as dropCache } from '@/db/cache';
import * as tabUnlock from '@/db/unlock';

/**
 * anonymous — no session at all.
 * resuming  — this tab left an unlock record behind and is opening it. Transient, and only
 *             ever the state the app starts in.
 * locked    — the refresh token survived a reload but the master key did not, so the
 *             passphrase has to be entered again. This is the "KEY UNLOCKED" indicator.
 * kit       — keys are ready, but a freshly issued recovery code has not been acknowledged.
 *             It is a state of its own so that no redirect can skip past the one screen
 *             where that code is ever shown.
 * unlocked  — keys are in memory and the vaults can be read.
 */
export type SessionStatus = 'anonymous' | 'resuming' | 'locked' | 'kit' | 'unlocked';

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
  resume: () => Promise<void>;
  register: (input: authApi.RegisterInput) => Promise<void>;
  recover: (login: string, code: string, passphrase: string) => Promise<void>;
  acknowledgeKit: () => void;
  updateDisplayName: (displayName: string) => Promise<void>;
  changePassphrase: (current: string, next: string) => Promise<void>;
  deleteAccount: (passphrase: string) => Promise<void>;
  signOut: () => Promise<void>;
  lock: () => void;
  clearError: () => void;
}

function initialStatus(): SessionStatus {
  if (!readSession()) return 'anonymous';

  return tabUnlock.pending() ? 'resuming' : 'locked';
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
      await tabUnlock.remember(session.user.login, session.masterKey);

      set({ ...session, status: 'unlocked', knownLogin: session.user.login });
    });
  },

  unlock: async (passphrase) => {
    await run(set, async () => {
      const session = await authApi.unlock(passphrase);
      await tabUnlock.remember(session.user.login, session.masterKey);

      set({ ...session, status: 'unlocked', knownLogin: session.user.login });
    });
  },

  /**
   * Opens the record this tab left behind before its last reload. Runs once, at startup,
   * and every way it can fail lands on the same place: the unlock screen. A record that
   * does not open, a session the server has since revoked and a browser with no storage
   * at all are the same event here — nothing was resumed.
   */
  resume: async () => {
    if (get().status !== 'resuming') return;

    try {
      const resumed = await tabUnlock.resume();

      if (!resumed) {
        set({ status: 'locked' });

        return;
      }

      const session = await authApi.resumeWith(resumed.masterKey);
      set({ ...session, status: 'unlocked', knownLogin: session.user.login });
    } catch {
      await tabUnlock.forget();

      // A 401 on the way has already taken the session apart through the lost handler, and
      // that verdict outranks this one: there is no session left to be merely locked.
      if (get().status === 'resuming') set({ status: 'locked' });
    }
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

  /** The first point where a reload may skip the passphrase: before it, the unshown code
   *  would be lost to a resume that walked straight past this screen. */
  acknowledgeKit: () => {
    const { user, masterKey } = get();

    set({ status: 'unlocked', pendingRecoveryCode: null });

    if (user && masterKey) void tabUnlock.remember(user.login, masterKey);
  },

  updateDisplayName: async (displayName) => {
    await run(set, async () => {
      set({ user: await authApi.updateDisplayName(displayName) });
    });
  },

  /**
   * Re-wraps the master key with a key from the new passphrase. The key itself does not
   * change, so nothing that was sealed under it has to be touched — but the recovery code
   * is rotated with the wrap, and it is shown exactly once. That is what the kit state is
   * for, so the session goes back through it rather than dropping a new code on the floor.
   */
  changePassphrase: async (current, next) => {
    await run(set, async () => {
      const { user, masterKey } = get();

      if (!user || !masterKey) throw new Error('Unlock your keys before changing the passphrase.');

      const { recoveryCode } = await authApi.changePassphrase(user.login, current, next, masterKey);

      // The wrap would still open — the master key is the same one — but a reload before
      // the new code is acknowledged has to land on the kit, not past it.
      await tabUnlock.forget();

      set({ status: 'kit', pendingRecoveryCode: recoveryCode, knownLogin: user.login });
    });
  },

  deleteAccount: async (passphrase) => {
    await run(set, async () => {
      await authApi.deleteAccount(passphrase);
      await tabUnlock.forget();
      await dropCache().catch(() => undefined);

      set({
        status: 'anonymous',
        user: null,
        identity: null,
        masterKey: null,
        knownLogin: null,
        pendingRecoveryCode: null,
        error: null,
      });
    });
  },

  signOut: async () => {
    await authApi.signOut().catch(() => undefined);
    await tabUnlock.forget();
    await dropCache().catch(() => undefined);

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

    // The record goes with them, or a reload would undo the lock the user just asked for.
    void tabUnlock.forget();

    set({ status: get().user ? 'locked' : 'anonymous', identity: null, masterKey: null });
  },

  clearError: () => set({ error: null }),
}));

setSessionLostHandler(() => {
  clearSession();
  void tabUnlock.forget();

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
