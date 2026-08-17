import * as connectivity from '@/sync/connectivity';

import { type ErrorEnvelope, ErrorCode, type Tokens } from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
    readonly requestId?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  is(code: string): boolean {
    return this.code === code;
  }
}

/** Thrown when the request never reached the server, so a retry is meaningful. */
export class OfflineError extends Error {
  constructor() {
    super('the server is unreachable');
    this.name = 'OfflineError';
  }
}

interface Session {
  refreshToken: string;
  refreshExpiresAt: string;
  login: string;
}

const SESSION_KEY = 'shelf.session';
const REFRESH_LOCK = 'shelf.refresh';

// The access token stays in memory only. The refresh token survives a reload so the user
// lands on the unlock screen rather than the sign-in screen; the master key never
// persists at all, which is why unlocking always asks for the passphrase again.
let accessToken: string | null = null;
let accessExpiresAt = 0;
let refreshing: Promise<void> | null = null;
let onSessionLost: (() => void) | null = null;

/**
 * How long before its expiry an access token is replaced.
 *
 * A request that finds its token stale gets a 401 and retries, which costs a round trip and
 * nothing else. A websocket cannot do that — it has already been accepted — so the socket
 * asks for a token that will still be valid by the time it arrives.
 */
const TOKEN_MARGIN_MS = 60_000;

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const session = JSON.parse(raw) as Session;

    return Date.parse(session.refreshExpiresAt) > Date.now() ? session : null;
  } catch {
    // Either the entry is not what this version wrote, or the store itself is unreachable —
    // blocked by the browser, or full. Both mean there is no session to resume, which is a
    // signed-out user rather than a crash on every request.
    return null;
  }
}

export function storeTokens(tokens: Tokens, login: string): void {
  accessToken = tokens.access_token;
  accessExpiresAt = Date.parse(tokens.access_expires_at);

  const session: Session = {
    refreshToken: tokens.refresh_token,
    refreshExpiresAt: tokens.refresh_expires_at,
    login,
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  accessToken = null;
  accessExpiresAt = 0;
  localStorage.removeItem(SESSION_KEY);
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

/**
 * The access token, refreshed first when this tab does not hold one.
 *
 * Exposed for the realtime socket, which authenticates in its first frame rather than in a
 * header — a browser cannot set one on a websocket, and a token in the query string lands
 * in every access log on the way.
 */
export async function socketToken(): Promise<string> {
  if (accessToken === null || Date.now() >= accessExpiresAt - TOKEN_MARGIN_MS) await refresh();
  if (accessToken === null) throw new ApiError(401, ErrorCode.Unauthorized, 'session expired');

  return accessToken;
}

/** Called when the refresh token is gone or rejected and the user has to sign in again. */
export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Skips the bearer header and the refresh retry, for the endpoints that take neither. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  // A reload keeps the session but not the access token. Sending a request that is bound to
  // 401 costs a round trip per call, and on the unlock screen that is two of them before
  // anything the user typed is even looked at.
  if (!options.anonymous && accessToken === null && readSession()) await refresh();

  const sentWith = accessToken;
  const response = await send(method, path, options);

  if (response.status === 401 && !options.anonymous) {
    // Only when nobody has replaced the token meanwhile. A burst of parallel requests all
    // answered 401 would otherwise rotate the session once per request, and every rotation
    // is another chance for a second tab to present a token that has just been spent.
    if (accessToken === sentWith) await refresh();

    return parse<T>(await send(method, path, options));
  }

  return parse<T>(response);
}

async function send(method: string, path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.anonymous && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  try {
    const response = await fetch(BASE + path, {
      method,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // Every request is a probe, including the ones that come back 4xx: an answer of any
    // shape means the server is there, which is the only thing this records.
    connectivity.markReachable();

    return response;
  } catch (cause) {
    // An aborted request says nothing about the network — it was called off from here.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;

    connectivity.markUnreachable();

    throw new OfflineError();
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;

    return (await response.json()) as T;
  }

  throw await toError(response);
}

async function toError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get('Retry-After')) || undefined;

  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // A proxy or a crash can answer with something other than the envelope.
  }

  const error = envelope?.error;

  return new ApiError(
    response.status,
    error?.code ?? ErrorCode.Internal,
    error?.message ?? response.statusText,
    error?.details,
    error?.request_id,
    retryAfter,
  );
}

/**
 * Single flight, and single tab at a time: a burst of parallel requests that all see 401
 * must produce one refresh, not one per request — the refresh token is single-use, and a
 * second use is treated by the server as theft and revokes every session.
 *
 * The in-process promise only covers this tab, which is not enough: two tabs reloaded
 * together both start with no access token and both hold the same stored refresh token, so
 * the second one to arrive would spend a token the first had already used and sign the
 * account out everywhere. The lock serialises them across tabs, and the token is read inside
 * it, so whoever comes second exchanges the pair the winner has just stored.
 */
function refresh(): Promise<void> {
  refreshing ??= exchangeUnderLock().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

async function exchangeUnderLock(): Promise<void> {
  // Web Locks needs a secure context and is not everywhere; without it the exchange is
  // still single-flight within this tab, which is where it was before.
  const locks: LockManager | undefined = navigator.locks;

  if (!locks) return exchangeRefreshToken();

  await locks.request(REFRESH_LOCK, exchangeRefreshToken);
}

async function exchangeRefreshToken(): Promise<void> {
  const session = readSession();

  if (!session) {
    clearSession();
    onSessionLost?.();

    throw new ApiError(401, ErrorCode.Unauthorized, 'session expired');
  }

  let response: Response;
  try {
    response = await send('POST', '/auth/refresh', {
      body: { refresh_token: session.refreshToken },
      anonymous: true,
    });
  } catch (cause) {
    // Offline is not a lost session: keep the tokens and let the caller retry later.
    throw cause;
  }

  if (!response.ok) {
    clearSession();
    onSessionLost?.();

    throw await toError(response);
  }

  storeTokens((await response.json()) as Tokens, session.login);
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options ?? {}),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, ...(body === undefined ? {} : { body }) }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, ...(body === undefined ? {} : { body }) }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, ...(body === undefined ? {} : { body }) }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options ?? {}),
};
