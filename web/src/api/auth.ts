import type { Sealed } from '@/crypto/aead';
import { b64ToBytes, bytesToB64 } from '@/crypto/bytes';
import {
  generateIdentity,
  generateMasterKey,
  type Identity,
  unwrapIdentity,
  unwrapMasterKey,
  wrapMasterKey,
} from '@/crypto/identity';
import { DEFAULT_KDF_PARAMS, deriveAccountKeys, deriveRecoveryKeys, newSalt } from '@/crypto/kdf';
import { generateRecoveryCode } from '@/crypto/recovery';

import { api, clearSession, readSession, storeTokens } from './client';
import type {
  CredentialsRequest,
  DevicesResponse,
  Keys,
  PreloginResponse,
  RecoveryChallenge,
  RecoveryKeyRequest,
  RegisterRequest,
  SessionResponse,
  Tokens,
  User,
} from './types';

/** Everything the app needs after a successful unlock. None of it is ever persisted. */
export interface UnlockedSession {
  user: User;
  identity: Identity;
  masterKey: CryptoKey;
}

export interface RegisterInput {
  login: string;
  displayName: string;
  passphrase: string;
}

export interface Registered {
  session: UnlockedSession;
  /** Shown once and downloaded as the recovery kit; the server never sees it. */
  recoveryCode: string;
}

export async function register({ login, displayName, passphrase }: RegisterInput): Promise<Registered> {
  const masterKey = await generateMasterKey();

  const salt = newSalt();
  const account = await deriveAccountKeys(passphrase, salt);
  const wrappedMaster = await wrapMasterKey(masterKey, account.wrappingKey);

  const identity = await generateIdentity(masterKey);

  const recoveryCode = generateRecoveryCode();
  const recovery = await recoveryPayload(recoveryCode, login, masterKey);

  const body: RegisterRequest = {
    login,
    display_name: displayName,
    auth_hash: bytesToB64(account.authHash),
    kdf_salt: bytesToB64(salt),
    kdf_params: DEFAULT_KDF_PARAMS,
    wrapped_master_key: bytesToB64(wrappedMaster.ciphertext),
    master_key_nonce: bytesToB64(wrappedMaster.nonce),
    public_key: bytesToB64(identity.publicBlob),
    wrapped_private_key: bytesToB64(identity.wrappedPrivateKey),
    private_key_nonce: bytesToB64(identity.privateKeyNonce),
    recovery,
  };

  const response = await api.post<SessionResponse>('/auth/register', body, { anonymous: true });
  storeTokens(response.tokens, response.user.login);

  return {
    session: { user: response.user, identity: identity.identity, masterKey },
    recoveryCode,
  };
}

export async function signIn(login: string, passphrase: string): Promise<UnlockedSession> {
  // prelogin answers for unknown logins too, with a decoy salt, so this step leaks nothing.
  const prelogin = await api.post<PreloginResponse>('/auth/prelogin', { login }, { anonymous: true });

  const account = await deriveAccountKeys(passphrase, b64ToBytes(prelogin.kdf_salt), prelogin.kdf_params);

  const response = await api.post<SessionResponse>(
    '/auth/login',
    { login, auth_hash: bytesToB64(account.authHash) },
    { anonymous: true },
  );

  storeTokens(response.tokens, response.user.login);

  return { user: response.user, ...(await openKeys(response.keys, account.wrappingKey)) };
}

/**
 * Re-derives the keys for a session that survived a reload. The refresh token persists,
 * the master key does not, so the passphrase is asked for again — that is what the
 * "KEY UNLOCKED" state in the sidebar actually tracks.
 *
 * The account is read only after the wrap opens. Nothing about the passphrase can be checked
 * server-side here — the session is already valid, and the wrapped key either decrypts or it
 * does not — so a wrong one costs a single request and gets back nothing but ciphertext.
 */
export async function unlock(passphrase: string): Promise<UnlockedSession> {
  const keys = await api.get<Keys>('/auth/keys');
  const account = await deriveAccountKeys(passphrase, b64ToBytes(keys.kdf_salt), keys.kdf_params);
  const opened = await openKeys(keys, account.wrappingKey);

  return { user: await api.get<User>('/auth/me'), ...opened };
}

/** The display name is the one account field the server can read, so the only one it can change. */
export function updateDisplayName(displayName: string): Promise<User> {
  return api.patch<User>('/auth/me', { display_name: displayName });
}

/**
 * Destroys the account, the vaults it owns and every session it holds.
 *
 * The passphrase is proved again rather than the open session taken at its word: an access
 * token says a browser was signed in at some point, which is not the same as the owner
 * asking for the one thing here that nothing undoes.
 */
export async function deleteAccount(passphrase: string): Promise<void> {
  const keys = await api.get<Keys>('/auth/keys');
  const account = await deriveAccountKeys(passphrase, b64ToBytes(keys.kdf_salt), keys.kdf_params);

  await api.delete<void>('/auth/me', { body: { auth_hash: bytesToB64(account.authHash) } });

  clearSession();
}

export async function signOut(): Promise<void> {
  const session = readSession();

  if (session) {
    await api
      .post<void>('/auth/logout', { refresh_token: session.refreshToken }, { anonymous: true })
      .catch(() => undefined);
  }

  clearSession();
}

export async function signOutEverywhere(): Promise<void> {
  await api.post<void>('/auth/logout-all');
  clearSession();
}

export function listDevices(): Promise<DevicesResponse> {
  return api.get<DevicesResponse>('/auth/sessions');
}

export function revokeDevice(id: number): Promise<void> {
  return api.delete<void>(`/auth/sessions/${id}`);
}

export interface RecoverySession {
  challenge: RecoveryChallenge;
  masterKey: CryptoKey;
}

/**
 * Proves ownership of the recovery code and unwraps the master key with it. The server
 * checks a verifier derived from the same code in a different context, so what it stores
 * can never unwrap anything.
 */
export async function startRecovery(login: string, code: string): Promise<RecoverySession> {
  const recovery = await deriveRecoveryKeys(code, login);

  const challenge = await api.post<RecoveryChallenge>(
    '/auth/recovery/start',
    { login, recovery_auth_hash: bytesToB64(recovery.authHash) },
    { anonymous: true },
  );

  const masterKey = await unwrapMasterKey(
    sealedFrom(challenge.wrapped_master_key, challenge.nonce),
    recovery.wrappingKey,
  );

  return { challenge, masterKey };
}

export async function completeRecovery(
  login: string,
  recoverySession: RecoverySession,
  passphrase: string,
): Promise<{ recoveryCode: string }> {
  const { credentials, recoveryCode } = await newCredentials(login, passphrase, recoverySession.masterKey);

  const tokens = await api.post<Tokens>(
    '/auth/recovery/complete',
    { recovery_token: recoverySession.challenge.recovery_token, ...credentials },
    { anonymous: true },
  );

  storeTokens(tokens, login);

  return { recoveryCode };
}

/**
 * Re-wraps the master key with a key from the new passphrase. The master key itself does
 * not change, so the identity keypairs and every scope key stay valid.
 */
export async function changePassphrase(
  login: string,
  currentPassphrase: string,
  nextPassphrase: string,
  masterKey: CryptoKey,
): Promise<{ recoveryCode: string }> {
  const keys = await api.get<Keys>('/auth/keys');
  const current = await deriveAccountKeys(currentPassphrase, b64ToBytes(keys.kdf_salt), keys.kdf_params);

  const { credentials, recoveryCode } = await newCredentials(login, nextPassphrase, masterKey);

  const tokens = await api.post<Tokens>('/auth/password', {
    current_auth_hash: bytesToB64(current.authHash),
    ...credentials,
  });

  storeTokens(tokens, login);

  return { recoveryCode };
}

/** Opens the wrapped key pair, which is also the only check a passphrase ever gets. */
async function openKeys(
  keys: Keys,
  wrappingKey: CryptoKey,
): Promise<Omit<UnlockedSession, 'user'>> {
  const masterKey = await unwrapMasterKey(
    sealedFrom(keys.wrapped_master_key, keys.master_key_nonce),
    wrappingKey,
  );

  const identity = await unwrapIdentity(
    b64ToBytes(keys.public_key),
    sealedFrom(keys.wrapped_private_key, keys.private_key_nonce),
    masterKey,
  );

  return { identity, masterKey };
}

/** Builds a fresh passphrase wrap plus a rotated recovery key, which always travel together. */
async function newCredentials(
  login: string,
  passphrase: string,
  masterKey: CryptoKey,
): Promise<{ credentials: CredentialsRequest; recoveryCode: string }> {
  const salt = newSalt();
  const account = await deriveAccountKeys(passphrase, salt);
  const wrapped = await wrapMasterKey(masterKey, account.wrappingKey);

  const recoveryCode = generateRecoveryCode();

  return {
    credentials: {
      auth_hash: bytesToB64(account.authHash),
      kdf_salt: bytesToB64(salt),
      kdf_params: DEFAULT_KDF_PARAMS,
      wrapped_master_key: bytesToB64(wrapped.ciphertext),
      master_key_nonce: bytesToB64(wrapped.nonce),
      recovery: await recoveryPayload(recoveryCode, login, masterKey),
    },
    recoveryCode,
  };
}

async function recoveryPayload(
  code: string,
  login: string,
  masterKey: CryptoKey,
): Promise<RecoveryKeyRequest> {
  const recovery = await deriveRecoveryKeys(code, login);
  const wrapped = await wrapMasterKey(masterKey, recovery.wrappingKey);

  return {
    auth_hash: bytesToB64(recovery.authHash),
    wrapped_master_key: bytesToB64(wrapped.ciphertext),
    nonce: bytesToB64(wrapped.nonce),
  };
}

function sealedFrom(ciphertext: string, nonce: string): Sealed {
  return { ciphertext: b64ToBytes(ciphertext), nonce: b64ToBytes(nonce) };
}
