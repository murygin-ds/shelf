// Package mcp is the Claude connector: the one place where this server is handed a key.
//
// Everything else in Shelf is built on the server not having one, and this package does not
// change that for any vault whose owner has not asked for it. A connector is an account like
// any other — the same identity blob, the same membership, the same key grant — so the
// permission model, the rotation and the member list all keep working without learning about
// it. What is different is only where its private half comes from: the browser derives one
// from a passphrase, and a connector's is wrapped by the secret in this service's config.
package mcp

import (
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"fmt"

	"shelf/internal/envelope"

	"github.com/google/uuid"
)

const (
	// wrappingInfo labels the key derived from the configured secret. It is a stored format:
	// changing it makes every connector already in the database unopenable.
	wrappingInfo = "shelf/mcp/connector-key/v1"

	// kdfParams describes how this account's master key is wrapped, so the row says what it
	// is rather than looking like a password account whose Argon2 parameters went missing.
	kdfParams = `{"kdf":"hkdf-sha256","info":"` + wrappingInfo + `"}`

	// DisplayName is what the member list shows. It names what it is: somebody reading the
	// members of a vault should see the server among them, not a plausible-looking person.
	DisplayName = "Claude connector"

	// loginPrefix marks the account as one nobody signs in to. The random half is what keeps
	// prelogin from confirming a guessable name exists.
	loginPrefix = "connector.mcp."

	saltLength = 16
)

// Hasher turns a secret into the stored form of an account's auth hash.
type Hasher interface {
	Hash(secret []byte) (string, error)
}

// Account is a connector's identity in the shape the users table already stores.
type Account struct {
	Login       string
	DisplayName string
	// AuthHash is over random bytes nobody holds. The column cannot be empty, and a
	// connector must not be an account somebody can sign in to.
	AuthHash          string
	KDFSalt           []byte
	KDFParams         []byte
	PublicKey         []byte
	WrappedMasterKey  []byte
	MasterKeyNonce    []byte
	WrappedPrivateKey []byte
	PrivateKeyNonce   []byte
	// Fingerprint is shown to the person enabling the connector, and stored beside the vault
	// so that a server whose secret changed is noticed rather than silently failing to open
	// anything.
	Fingerprint string
}

// StoredKeys is what a connector's users row holds, in the columns it holds it in.
type StoredKeys struct {
	KDFSalt           []byte
	PublicKey         []byte
	WrappedMasterKey  []byte
	MasterKeyNonce    []byte
	WrappedPrivateKey []byte
	PrivateKeyNonce   []byte
}

// NewAccount mints the identity of a connector.
//
// The layering is the one a person's account uses: a master key wrapped by something derived
// from a secret, and the identity bundle wrapped by that master key. Keeping the shape means
// the rest of the system cannot tell the difference, which is the point.
func NewAccount(secret string, hasher Hasher) (*Account, error) {
	if secret == "" {
		return nil, fmt.Errorf("no connector secret configured")
	}

	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("read salt: %w", err)
	}

	wrapping, err := wrappingKey(secret, salt)
	if err != nil {
		return nil, err
	}

	masterKey := make([]byte, envelope.KeyLength)
	if _, err := rand.Read(masterKey); err != nil {
		return nil, fmt.Errorf("read master key: %w", err)
	}

	wrappedMaster, err := envelope.WrapMasterKey(masterKey, wrapping)
	if err != nil {
		return nil, fmt.Errorf("wrap master key: %w", err)
	}

	identity, err := envelope.GenerateIdentity()
	if err != nil {
		return nil, err
	}

	bundle, err := identity.MarshalPrivateBundle()
	if err != nil {
		return nil, err
	}

	wrappedIdentity, err := envelope.WrapIdentity(bundle, masterKey)
	if err != nil {
		return nil, fmt.Errorf("wrap identity: %w", err)
	}

	authHash, err := unusableAuthHash(hasher)
	if err != nil {
		return nil, err
	}

	return &Account{
		Login:             loginPrefix + uuid.NewString(),
		DisplayName:       DisplayName,
		AuthHash:          authHash,
		KDFSalt:           salt,
		KDFParams:         []byte(kdfParams),
		PublicKey:         identity.PublicBlob,
		WrappedMasterKey:  wrappedMaster.Ciphertext,
		MasterKeyNonce:    wrappedMaster.Nonce,
		WrappedPrivateKey: wrappedIdentity.Ciphertext,
		PrivateKeyNonce:   wrappedIdentity.Nonce,
		Fingerprint:       envelope.Fingerprint(identity.PublicBlob),
	}, nil
}

// OpenIdentity recovers a connector's keys from its row. It is the only step that needs the
// configured secret, and the result is held in memory for as long as a request takes.
func OpenIdentity(secret string, keys StoredKeys) (*envelope.Identity, error) {
	if secret == "" {
		return nil, fmt.Errorf("no connector secret configured")
	}

	wrapping, err := wrappingKey(secret, keys.KDFSalt)
	if err != nil {
		return nil, err
	}

	masterKey, err := envelope.UnwrapMasterKey(
		envelope.Sealed{Ciphertext: keys.WrappedMasterKey, Nonce: keys.MasterKeyNonce}, wrapping)
	if err != nil {
		// Almost always the secret, and saying so saves reading this code to find out.
		return nil, fmt.Errorf("unwrap connector master key, mcp.secret may have changed: %w", err)
	}

	return envelope.UnwrapIdentity(
		keys.PublicKey,
		envelope.Sealed{Ciphertext: keys.WrappedPrivateKey, Nonce: keys.PrivateKeyNonce},
		masterKey,
	)
}

func wrappingKey(secret string, salt []byte) ([]byte, error) {
	key, err := hkdf.Key(sha256.New, []byte(secret), salt, wrappingInfo, envelope.KeyLength)
	if err != nil {
		return nil, fmt.Errorf("derive connector wrapping key: %w", err)
	}

	return key, nil
}

// unusableAuthHash produces a well-formed hash of bytes that are discarded, so the column
// holds something the login path can parse and nothing can satisfy.
func unusableAuthHash(hasher Hasher) (string, error) {
	secret := make([]byte, envelope.KeyLength)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("read auth hash seed: %w", err)
	}

	hash, err := hasher.Hash(secret)
	if err != nil {
		return "", fmt.Errorf("hash connector secret: %w", err)
	}

	return hash, nil
}
