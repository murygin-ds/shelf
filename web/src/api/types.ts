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

/**
 * Mirrors internal/api/response/reason.go, in the same order and the same groups.
 *
 * The nine codes are too coarse to say anything specific — one `conflict` covers a login
 * already taken and a membership already held — so the server names the cause in
 * `details.reason` and `describe` turns it into a sentence. A reason this client has never
 * heard of is not an error: it falls through to the code.
 */
export const ErrorReason = {
  RouteNotFound: 'route_not_found',
  MethodNotAllowed: 'method_not_allowed',
  BodyTooLarge: 'body_too_large',
  QueryInvalid: 'query_invalid',
  IfMatchRequired: 'if_match_required',
  IfMatchInvalid: 'if_match_invalid',
  RateLimited: 'rate_limited',
  Internal: 'internal',
  DatabaseUnavailable: 'database_unavailable',

  AuthHeaderMissing: 'auth_header_missing',
  TokenInvalid: 'token_invalid',
  Unauthenticated: 'unauthenticated',

  LoginBlank: 'login_blank',
  LoginTaken: 'login_taken',
  InvalidCredentials: 'invalid_credentials',
  PasswordInvalid: 'password_invalid',
  DisplayNameBlank: 'display_name_blank',
  RefreshInvalid: 'refresh_token_invalid',
  RefreshReused: 'refresh_token_reused',
  RecoveryCodeInvalid: 'recovery_code_invalid',
  RecoveryTokenInvalid: 'recovery_token_invalid',
  SessionIDInvalid: 'session_id_invalid',
  SessionNotFound: 'session_not_found',

  NotFound: 'not_found',
  Forbidden: 'forbidden',
  VersionConflict: 'version_conflict',
  ScopeMismatch: 'scope_mismatch',
  FolderCycle: 'folder_cycle',
  DepthExceeded: 'depth_exceeded',
  ShareExpiry: 'share_expiry',
  LinkBatch: 'link_batch',
  SignatureInvalid: 'signature_invalid',
  RekeyStale: 'rekey_stale',
  KeyGrantMissing: 'key_grant_missing',
  RekeyBatch: 'rekey_batch',
  EpochMismatch: 'epoch_mismatch',
  CompactRequired: 'compact_required',
  UpdateTooLarge: 'update_too_large',
  LabelIncomplete: 'label_incomplete',

  OwnerRequired: 'owner_required',
  SelfTarget: 'self_target',
  AlreadyMember: 'already_member',
  KeysRequired: 'keys_required',
  GroupMembers: 'group_members',
  GroupKeyless: 'group_keyless',
  GroupScopes: 'group_scopes',
  GroupRotation: 'group_rotation',
  InvitePath: 'invite_path',
  RedeemPath: 'redeem_path',

  ConnectorRole: 'connector_role_invalid',
  ConnectorExists: 'connector_exists',
} as const;

/** The details key the reason travels under. `response.ReasonKey`. */
export const REASON_KEY = 'reason';

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
