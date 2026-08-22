package mcp

import (
	"shelf/internal/envelope"
	"shelf/internal/vault"
)

// supportedAlgorithm is the only wrapping this side reads. A grant written under anything
// else is skipped rather than guessed at.
const supportedAlgorithm = "ecdh-p256-hkdf-a256gcm"

// Keyring holds the scope keys a connector can open, by scope and version.
//
// Old versions are kept alongside current ones for the same reason the browser keeps them:
// the trash and the revision history are sealed under the key that was current when they
// were written, and dropping it would make them unreadable rather than merely stale.
type Keyring struct {
	keys map[slot][]byte
}

type slot struct {
	scopeID int64
	version int32
}

// NewKeyring opens every grant it can and passes over the rest.
//
// A grant that will not open is the ordinary case, not a failure: a folder given its own key
// is simply outside what this connector may see. Refusing to build the ring would turn a
// vault with one private folder into a vault the connector cannot read at all.
func NewKeyring(identity *envelope.Identity, grants []vault.KeyGrant) *Keyring {
	ring := &Keyring{keys: make(map[slot][]byte, len(grants))}

	for _, grant := range grants {
		if grant.Algorithm != "" && grant.Algorithm != supportedAlgorithm {
			continue
		}

		key, err := envelope.Open(
			identity.Seal,
			envelope.Box{Blob: grant.WrappedKey, Nonce: grant.Nonce},
			envelope.SealInfo(grant.ScopeClientID, grant.KeyVersion),
		)
		if err != nil || len(key) != envelope.KeyLength {
			continue
		}

		ring.keys[slot{scopeID: grant.ScopeID, version: grant.KeyVersion}] = key
	}

	return ring
}

// Get returns the key for one slot, or nil when the connector holds none. A nil key is a
// state the callers render as locked rather than an error they abort on.
func (k *Keyring) Get(scopeID int64, version int32) []byte {
	return k.keys[slot{scopeID: scopeID, version: version}]
}

// Has reports whether any version of a scope is readable, which is what decides whether a
// subtree is offered at all.
func (k *Keyring) Has(scopeID int64) bool {
	for at := range k.keys {
		if at.scopeID == scopeID {
			return true
		}
	}

	return false
}

// Len is the number of slots opened, for logging that says how much of a vault is reachable
// without saying anything about what is in it.
func (k *Keyring) Len() int { return len(k.keys) }
