package mcp

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"shelf/internal/envelope"
)

type stubHasher struct{}

func (stubHasher) Hash(secret []byte) (string, error) {
	sum := sha256.Sum256(secret)

	return "$stub$" + hex.EncodeToString(sum[:]), nil
}

const secret = "a-configured-secret-of-at-least-32-chars"

func newAccount(t *testing.T) *Account {
	t.Helper()

	account, err := NewAccount(secret, stubHasher{})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}

	return account
}

func TestAccountRoundTrips(t *testing.T) {
	account := newAccount(t)

	identity, err := OpenIdentity(secret, storedKeysOf(account))
	if err != nil {
		t.Fatalf("OpenIdentity: %v", err)
	}

	if !bytes.Equal(identity.PublicBlob, account.PublicKey) {
		t.Error("the recovered identity carries a different public blob")
	}

	// The half that matters: a scope key sealed to the account has to open with what came
	// back out of the row, because that is the whole path a grant travels.
	sealPublic, _, err := envelope.SplitPublicBlob(account.PublicKey)
	if err != nil {
		t.Fatalf("SplitPublicBlob: %v", err)
	}

	scopeKey := bytes.Repeat([]byte{7}, envelope.KeyLength)
	info := envelope.SealInfo("6f1c2a90-3b4d-4e5f-8a71-2c3d4e5f6a7b", 1)

	box, err := envelope.Seal(sealPublic, scopeKey, info)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	opened, err := envelope.Open(identity.Seal, box, info)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if !bytes.Equal(opened, scopeKey) {
		t.Error("the sealed scope key came back different")
	}
}

func TestAccountRefusesTheWrongSecret(t *testing.T) {
	account := newAccount(t)

	if _, err := OpenIdentity(secret+"x", storedKeysOf(account)); err == nil {
		t.Fatal("a connector opened under a secret it was not wrapped with")
	}

	if _, err := OpenIdentity("", storedKeysOf(account)); err == nil {
		t.Fatal("a connector opened with no secret configured")
	}

	if _, err := NewAccount("", stubHasher{}); err == nil {
		t.Fatal("an account was minted with no secret configured")
	}
}

// Two connectors must not share a wrapping key, which is what the per-account salt is for.
func TestAccountsAreIndependent(t *testing.T) {
	first, second := newAccount(t), newAccount(t)

	for _, pair := range []struct {
		name string
		a, b []byte
	}{
		{"salt", first.KDFSalt, second.KDFSalt},
		{"public key", first.PublicKey, second.PublicKey},
		{"wrapped master key", first.WrappedMasterKey, second.WrappedMasterKey},
	} {
		if bytes.Equal(pair.a, pair.b) {
			t.Errorf("two accounts share a %s", pair.name)
		}
	}

	if first.Login == second.Login {
		t.Error("two accounts share a login")
	}

	if first.AuthHash == second.AuthHash {
		t.Error("two accounts share an auth hash")
	}

	// Swapping one account's salt for another's must not open anything.
	crossed := storedKeysOf(first)
	crossed.KDFSalt = second.KDFSalt

	if _, err := OpenIdentity(secret, crossed); err == nil {
		t.Error("a connector opened under another connector's salt")
	}
}

func TestAccountLooksLikeWhatItIs(t *testing.T) {
	account := newAccount(t)

	if !strings.HasPrefix(account.Login, loginPrefix) {
		t.Errorf("login %q is not marked as a connector", account.Login)
	}

	if account.Login == loginPrefix {
		t.Error("login carries no random half")
	}

	if account.DisplayName != DisplayName {
		t.Errorf("display name is %q", account.DisplayName)
	}

	if got := envelope.Fingerprint(account.PublicKey); got != account.Fingerprint {
		t.Errorf("fingerprint %q does not describe the public key (%q)", account.Fingerprint, got)
	}

	if len(account.PublicKey) != 1+envelope.PublicKeyLength*2 {
		t.Errorf("public blob is %d bytes", len(account.PublicKey))
	}

	if string(account.KDFParams) != kdfParams {
		t.Errorf("kdf params are %q", account.KDFParams)
	}
}

func storedKeysOf(a *Account) StoredKeys {
	return StoredKeys{
		KDFSalt:           a.KDFSalt,
		PublicKey:         a.PublicKey,
		WrappedMasterKey:  a.WrappedMasterKey,
		MasterKeyNonce:    a.MasterKeyNonce,
		WrappedPrivateKey: a.WrappedPrivateKey,
		PrivateKeyNonce:   a.PrivateKeyNonce,
	}
}
