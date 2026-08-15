package auth

import (
	"time"

	"shelf/internal/auth"
)

// Every binary field travels in JSON as base64 (the standard []byte encoding in
// encoding/json); the length bounds in the tags cut off obviously invalid input.

// kdfParams holds the client-side KDF parameters.
type kdfParams struct {
	Algorithm   string `binding:"required,oneof=argon2id" json:"algorithm"   example:"argon2id"`
	Memory      uint32 `binding:"required,min=19456"      json:"memory"      example:"65536"`
	Iterations  uint32 `binding:"required,min=2,max=16"   json:"iterations"  example:"3"`
	Parallelism uint8  `binding:"required,min=1,max=16"   json:"parallelism" example:"2"`
}

func (p kdfParams) toDomain() auth.KDFParams {
	return auth.KDFParams{
		Algorithm:   p.Algorithm,
		Memory:      p.Memory,
		Iterations:  p.Iterations,
		Parallelism: p.Parallelism,
	}
}

// recoveryKey is the master key wrapped with a key from the recovery code, plus the code verifier.
// auth_hash is derived by the client from the same recovery code but in a different context,
// so the master key cannot be unwrapped with it.
type recoveryKey struct {
	AuthHash         []byte `binding:"required,min=16,max=128"  json:"auth_hash"          format:"byte"`
	WrappedMasterKey []byte `binding:"required,min=32,max=1024" json:"wrapped_master_key" format:"byte"`
	Nonce            []byte `binding:"required,min=12,max=32"   json:"nonce"              format:"byte"`
}

func (k recoveryKey) toDomain() auth.NewRecoveryKey {
	return auth.NewRecoveryKey{
		AuthHash:         k.AuthHash,
		WrappedMasterKey: k.WrappedMasterKey,
		Nonce:            k.Nonce,
	}
}

// registerRequest is the registration request body.
type registerRequest struct {
	Login             string      `binding:"required,min=3,max=64"     json:"login"               example:"dmitry"`
	AuthHash          []byte      `binding:"required,min=16,max=128"   json:"auth_hash"           format:"byte"`
	KDFSalt           []byte      `binding:"required,min=16,max=64"    json:"kdf_salt"            format:"byte"`
	KDFParams         kdfParams   `binding:"required"                  json:"kdf_params"`
	WrappedMasterKey  []byte      `binding:"required,min=32,max=1024"  json:"wrapped_master_key"  format:"byte"`
	MasterKeyNonce    []byte      `binding:"required,min=12,max=32"    json:"master_key_nonce"    format:"byte"`
	PublicKey         []byte      `binding:"required,min=32,max=1024"  json:"public_key"          format:"byte"`
	WrappedPrivateKey []byte      `binding:"required,min=32,max=1024"  json:"wrapped_private_key" format:"byte"`
	PrivateKeyNonce   []byte      `binding:"required,min=12,max=32"    json:"private_key_nonce"   format:"byte"`
	Recovery          recoveryKey `binding:"required"                  json:"recovery"`
}

func (r registerRequest) toDomain(login string) auth.RegisterInput {
	return auth.RegisterInput{
		Login:    login,
		AuthHash: r.AuthHash,
		Keys: auth.KeyBundle{
			KDFSalt:           r.KDFSalt,
			KDFParams:         r.KDFParams.toDomain(),
			WrappedMasterKey:  r.WrappedMasterKey,
			MasterKeyNonce:    r.MasterKeyNonce,
			PublicKey:         r.PublicKey,
			WrappedPrivateKey: r.WrappedPrivateKey,
			PrivateKeyNonce:   r.PrivateKeyNonce,
		},
		Recovery: r.Recovery.toDomain(),
	}
}

// preloginRequest asks for the key derivation parameters before logging in.
type preloginRequest struct {
	Login string `binding:"required,min=3,max=64" json:"login" example:"dmitry"`
}

// PreloginResponse carries the salt and the KDF parameters for computing auth_hash on the client.
type PreloginResponse struct {
	KDFSalt   []byte         `format:"byte" json:"kdf_salt"`
	KDFParams auth.KDFParams `json:"kdf_params"`
}

// loginRequest is the login request body.
type loginRequest struct {
	Login    string `binding:"required,min=3,max=64"   json:"login"     example:"dmitry"`
	AuthHash []byte `binding:"required,min=16,max=128" json:"auth_hash" format:"byte"`
}

// refreshRequest is the body of the token pair refresh and logout requests.
type refreshRequest struct {
	RefreshToken string `binding:"required,min=16,max=256" json:"refresh_token"`
}

// changePasswordRequest changes the password when the current one is known.
// The client re-encrypts the master key with the new wrapping key; the
// public/private key pair does not change.
type changePasswordRequest struct {
	CurrentAuthHash  []byte       `binding:"required,min=16,max=128"  json:"current_auth_hash"   format:"byte"`
	AuthHash         []byte       `binding:"required,min=16,max=128"  json:"auth_hash"           format:"byte"`
	KDFSalt          []byte       `binding:"required,min=16,max=64"   json:"kdf_salt"            format:"byte"`
	KDFParams        kdfParams    `binding:"required"                 json:"kdf_params"`
	WrappedMasterKey []byte       `binding:"required,min=32,max=1024" json:"wrapped_master_key"  format:"byte"`
	MasterKeyNonce   []byte       `binding:"required,min=12,max=32"   json:"master_key_nonce"    format:"byte"`
	Recovery         *recoveryKey `json:"recovery,omitempty"`
}

func (r changePasswordRequest) toDomain() auth.CredentialsInput {
	return credentials(r.AuthHash, r.KDFSalt, r.KDFParams, r.WrappedMasterKey, r.MasterKeyNonce, r.Recovery)
}

// recoveryStartRequest proves ownership of the recovery code.
type recoveryStartRequest struct {
	Login string `binding:"required,min=3,max=64"   json:"login"              example:"dmitry"`
	// AuthHash is derived by the client from the recovery code and serves as the verifier.
	AuthHash []byte `binding:"required,min=16,max=128" json:"recovery_auth_hash" format:"byte"`
}

// RecoveryChallengeResponse carries the master key wrapped with the recovery code
// and the token the client completes the recovery with.
type RecoveryChallengeResponse struct {
	WrappedMasterKey []byte    `format:"byte" json:"wrapped_master_key"`
	Nonce            []byte    `format:"byte" json:"nonce"`
	RecoveryToken    string    `json:"recovery_token"`
	ExpiresAt        time.Time `json:"expires_at"`
}

// recoveryCompleteRequest carries the new authentication data after a recovery.
type recoveryCompleteRequest struct {
	RecoveryToken    string       `binding:"required"                 json:"recovery_token"`
	AuthHash         []byte       `binding:"required,min=16,max=128"  json:"auth_hash"          format:"byte"`
	KDFSalt          []byte       `binding:"required,min=16,max=64"   json:"kdf_salt"           format:"byte"`
	KDFParams        kdfParams    `binding:"required"                 json:"kdf_params"`
	WrappedMasterKey []byte       `binding:"required,min=32,max=1024" json:"wrapped_master_key" format:"byte"`
	MasterKeyNonce   []byte       `binding:"required,min=12,max=32"   json:"master_key_nonce"   format:"byte"`
	Recovery         *recoveryKey `json:"recovery,omitempty"`
}

func (r recoveryCompleteRequest) toDomain() auth.CredentialsInput {
	return credentials(r.AuthHash, r.KDFSalt, r.KDFParams, r.WrappedMasterKey, r.MasterKeyNonce, r.Recovery)
}

func credentials(
	authHash, salt []byte,
	params kdfParams,
	wrappedMasterKey, nonce []byte,
	recovery *recoveryKey,
) auth.CredentialsInput {
	creds := auth.CredentialsInput{
		AuthHash:         authHash,
		KDFSalt:          salt,
		KDFParams:        params.toDomain(),
		WrappedMasterKey: wrappedMasterKey,
		MasterKeyNonce:   nonce,
	}

	if recovery != nil {
		rotated := recovery.toDomain()
		creds.Recovery = &rotated
	}

	return creds
}

// TokensResponse is the issued token pair.
type TokensResponse struct {
	TokenType        string    `json:"token_type"         example:"Bearer"`
	AccessToken      string    `json:"access_token"`
	AccessExpiresAt  time.Time `json:"access_expires_at"`
	RefreshToken     string    `json:"refresh_token"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
}

func tokens(pair auth.TokenPair) TokensResponse {
	return TokensResponse{
		TokenType:        "Bearer",
		AccessToken:      pair.AccessToken,
		AccessExpiresAt:  pair.AccessExpiresAt,
		RefreshToken:     pair.RefreshToken,
		RefreshExpiresAt: pair.RefreshExpiresAt,
	}
}

// UserResponse holds the public account data.
type UserResponse struct {
	ID        int64     `json:"id"         example:"1"`
	Login     string    `json:"login"      example:"dmitry"`
	CreatedAt time.Time `json:"created_at"`
}

func user(u *auth.User) UserResponse {
	return UserResponse{ID: u.ID, Login: u.Login, CreatedAt: u.CreatedAt}
}

// KeysResponse holds the cryptographic material of the user. Only the client can decrypt it.
type KeysResponse struct {
	KDFSalt           []byte         `format:"byte" json:"kdf_salt"`
	KDFParams         auth.KDFParams `json:"kdf_params"`
	WrappedMasterKey  []byte         `format:"byte" json:"wrapped_master_key"`
	MasterKeyNonce    []byte         `format:"byte" json:"master_key_nonce"`
	PublicKey         []byte         `format:"byte" json:"public_key"`
	WrappedPrivateKey []byte         `format:"byte" json:"wrapped_private_key"`
	PrivateKeyNonce   []byte         `format:"byte" json:"private_key_nonce"`
}

func keys(bundle auth.KeyBundle) KeysResponse {
	return KeysResponse{
		KDFSalt:           bundle.KDFSalt,
		KDFParams:         bundle.KDFParams,
		WrappedMasterKey:  bundle.WrappedMasterKey,
		MasterKeyNonce:    bundle.MasterKeyNonce,
		PublicKey:         bundle.PublicKey,
		WrappedPrivateKey: bundle.WrappedPrivateKey,
		PrivateKeyNonce:   bundle.PrivateKeyNonce,
	}
}

// SessionResponse is the response carrying the token pair, the user and their keys.
type SessionResponse struct {
	User   UserResponse   `json:"user"`
	Keys   KeysResponse   `json:"keys"`
	Tokens TokensResponse `json:"tokens"`
}

// DeviceResponse is an active session of the user.
type DeviceResponse struct {
	ID         int64     `json:"id"           example:"12"`
	Current    bool      `json:"current"      example:"true"`
	UserAgent  string    `json:"user_agent"`
	IP         string    `json:"ip,omitempty" example:"203.0.113.7"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// DevicesResponse is the list of active sessions.
type DevicesResponse struct {
	Sessions []DeviceResponse `json:"sessions"`
}

func devices(sessions []auth.Session, currentID int64) DevicesResponse {
	out := make([]DeviceResponse, 0, len(sessions))

	for _, s := range sessions {
		device := DeviceResponse{
			ID:         s.ID,
			Current:    s.ID == currentID,
			UserAgent:  s.UserAgent,
			CreatedAt:  s.CreatedAt,
			LastUsedAt: s.LastUsedAt,
			ExpiresAt:  s.ExpiresAt,
		}

		if s.IP.IsValid() {
			device.IP = s.IP.String()
		}

		out = append(out, device)
	}

	return DevicesResponse{Sessions: out}
}
