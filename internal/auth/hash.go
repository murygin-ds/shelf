package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"shelf/internal/config"

	"golang.org/x/crypto/argon2"
)

// ErrInvalidHashFormat is returned when the string in the database is not a valid
// PHC-encoded Argon2id hash.
var ErrInvalidHashFormat = errors.New("invalid argon2 hash format")

const argon2Version = argon2.Version

// Hasher computes and verifies the server-side Argon2id on top of the client auth_hash:
// a database leak must not yield values that can be used to log in.
type Hasher struct {
	params config.Argon2
}

// NewHasher creates a hasher with the parameters from the configuration.
func NewHasher(params config.Argon2) Hasher {
	return Hasher{params: params}
}

// Hash returns the PHC-encoded hash of the secret: $argon2id$v=19$m=..,t=..,p=..$salt$hash.
func (h Hasher) Hash(secret []byte) (string, error) {
	salt := make([]byte, h.params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	sum := argon2.IDKey(secret, salt, h.params.Iterations, h.params.Memory, h.params.Parallelism, h.params.KeyLength)

	enc := base64.RawStdEncoding
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2Version, h.params.Memory, h.params.Iterations, h.params.Parallelism,
		enc.EncodeToString(salt), enc.EncodeToString(sum),
	), nil
}

// Verify compares a secret against a previously computed hash. The parameters come
// from the hash itself, so changing the settings does not break existing accounts.
func Verify(secret []byte, encoded string) (bool, error) {
	params, salt, want, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}

	got := argon2.IDKey(secret, salt, params.Iterations, params.Memory, params.Parallelism, uint32(len(want)))

	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// DummyVerify performs a throwaway hashing so that a login attempt with a
// non-existent login takes as long as one with an existing login.
func (h Hasher) DummyVerify(secret []byte) {
	salt := make([]byte, h.params.SaltLength)
	_ = argon2.IDKey(secret, salt, h.params.Iterations, h.params.Memory, h.params.Parallelism, h.params.KeyLength)
}

func decodeHash(encoded string) (config.Argon2, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return config.Argon2{}, nil, nil, ErrInvalidHashFormat
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return config.Argon2{}, nil, nil, ErrInvalidHashFormat
	}

	if version != argon2Version {
		return config.Argon2{}, nil, nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidHashFormat, version)
	}

	var params config.Argon2
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &params.Memory, &params.Iterations, &params.Parallelism); err != nil {
		return config.Argon2{}, nil, nil, ErrInvalidHashFormat
	}

	enc := base64.RawStdEncoding

	salt, err := enc.DecodeString(parts[4])
	if err != nil {
		return config.Argon2{}, nil, nil, ErrInvalidHashFormat
	}

	sum, err := enc.DecodeString(parts[5])
	if err != nil {
		return config.Argon2{}, nil, nil, ErrInvalidHashFormat
	}

	return params, salt, sum, nil
}
