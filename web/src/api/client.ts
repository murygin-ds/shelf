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

// The access token stays in memory only. The refresh token survives a reload so the user
// lands on the unlock screen rather than the sign-in screen; the master key never
// persists at all, which is why unlocking always asks for the passphrase again.
let accessToken: string | null = null;
let refreshing: Promise<void> | null = null;
let onSessionLost: (() => void) | null = null;

export function readSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as Session;

    return Date.parse(session.refreshExpiresAt) > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function storeTokens(tokens: Tokens, login: string): void {
  accessToken = tokens.access_token;

  const session: Session = {
    refreshToken: tokens.refresh_token,
    refreshExpiresAt: tokens.refresh_expires_at,
    login,
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  accessToken = null;
  localStorage.removeItem(SESSION_KEY);
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
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
  const response = await send(method, path, options);

  if (response.status === 401 && !options.anonymous) {
    await refresh();

    return parse<T>(await send(method, path, options));
  }

  return parse<T>(response);
}

async function send(method: string, path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.anonymous && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  try {
    return await fetch(BASE + path, {
      method,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;

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
 * Single flight: a burst of parallel requests that all see 401 must produce one refresh,
 * not one per request — the refresh token is single-use, and a second use is treated by
 * the server as theft and revokes every session.
 */
function refresh(): Promise<void> {
  refreshing ??= exchangeRefreshToken().finally(() => {
    refreshing = null;
  });

  return refreshing;
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
