import type { B64 } from '@/crypto/bytes';
import type { KdfParams } from '@/crypto/kdf';

/** Mirrors internal/api/response.Error. Only failures are enveloped; successes are bare. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
    request_id?: string;
  };
}

/** The codes internal/api/response defines. */
export const ErrorCode = {
  BadRequest: 'bad_request',
  Validation: 'validation_error',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  TooLarge: 'payload_too_large',
  TooManyRequests: 'too_many_requests',
  Internal: 'internal_error',
} as const;

export interface Tokens {
  token_type: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
}

export interface User {
  id: number;
  login: string;
  display_name: string;
  created_at: string;
}

export interface Keys {
  kdf_salt: B64;
  kdf_params: KdfParams;
  wrapped_master_key: B64;
  master_key_nonce: B64;
  public_key: B64;
  wrapped_private_key: B64;
  private_key_nonce: B64;
}

export interface SessionResponse {
  user: User;
  keys: Keys;
  tokens: Tokens;
}

export interface PreloginResponse {
  kdf_salt: B64;
  kdf_params: KdfParams;
}

export interface RecoveryChallenge {
  wrapped_master_key: B64;
  nonce: B64;
  recovery_token: string;
  expires_at: string;
}

export interface Device {
  id: number;
  current: boolean;
  user_agent: string;
  ip?: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

export interface DevicesResponse {
  sessions: Device[];
}

export interface RecoveryKeyRequest {
  auth_hash: B64;
  wrapped_master_key: B64;
  nonce: B64;
}

export interface RegisterRequest {
  login: string;
  display_name: string;
  auth_hash: B64;
  kdf_salt: B64;
  kdf_params: KdfParams;
  wrapped_master_key: B64;
  master_key_nonce: B64;
  public_key: B64;
  wrapped_private_key: B64;
  private_key_nonce: B64;
  recovery: RecoveryKeyRequest;
}

export interface CredentialsRequest {
  auth_hash: B64;
  kdf_salt: B64;
  kdf_params: KdfParams;
  wrapped_master_key: B64;
  master_key_nonce: B64;
  recovery?: RecoveryKeyRequest;
}
