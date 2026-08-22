// Package envelope repeats, on the server, the sealing the browser does in web/src/crypto.
//
// It exists for one caller: an MCP connector, which is the single place where this service
// is handed a key. Everything here is therefore a frozen wire format rather than an
// implementation detail — the additional-data strings, the padding, the sealed box layout
// and the identity blob are already written into every row the browser has produced, and a
// byte of drift here makes that data unreadable rather than merely incompatible.
//
// The pairing is guarded by shared vectors in testdata: both this package and
// web/src/crypto/vectors.test.ts read the same file, so a change on either side fails a
// test instead of corrupting a vault.
package envelope

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// EntityType names the kind of row a ciphertext belongs to. It is part of the additional
// data, so the set is closed by what has already been written.
type EntityType string

const (
	EntityVault    EntityType = "vault"
	EntityFolder   EntityType = "folder"
	EntityFile     EntityType = "file"
	EntityGroup    EntityType = "group"
	EntityRevision EntityType = "revision"
	EntityCRDT     EntityType = "crdt"
	EntityPresence EntityType = "presence"
)

// ErrLocked reports a ciphertext this caller holds no key for.
//
// A missing key is a state rather than a failure — a folder given its own key is simply not
// part of what a connector can see — so listing a tree returns locked rows next to readable
// ones instead of failing whole.
var ErrLocked = errors.New("no key for this slot")

// EntityRef identifies the exact slot a ciphertext belongs to.
//
// Both the entity and its key scope are named by client ids rather than serial ones: the
// browser picks them before the rows exist, which is what lets metadata be sealed with its
// final additional data in a single round trip.
type EntityRef struct {
	VaultID       int64
	Entity        EntityType
	EntityID      string
	ScopeClientID string
	KeyVersion    int32
}

// AAD binds a ciphertext to its slot. Without it a hostile server could move one note's
// ciphertext onto another note in the same scope and the client would decrypt it happily:
// confidentiality would hold, but placement would not.
func AAD(ref EntityRef) []byte {
	return join("shelf/v1",
		strconv.FormatInt(ref.VaultID, 10),
		string(ref.Entity),
		ref.EntityID,
		ref.ScopeClientID,
		strconv.FormatInt(int64(ref.KeyVersion), 10),
	)
}

// CRDTAAD is AAD with the epoch added, and the epoch is what makes it a different slot: an
// update carried into another epoch would merge into text it was never written against.
func CRDTAAD(ref EntityRef, epoch int32) []byte {
	return join("shelf/crdt/v1",
		strconv.FormatInt(ref.VaultID, 10),
		ref.EntityID,
		ref.ScopeClientID,
		strconv.FormatInt(int64(ref.KeyVersion), 10),
		strconv.FormatInt(int64(epoch), 10),
	)
}

// SealInfo binds a sealed scope key to the scope and version it unlocks.
func SealInfo(scopeClientID string, keyVersion int32) string {
	return "shelf/seal/v1|" + scopeClientID + "|" + strconv.FormatInt(int64(keyVersion), 10)
}

// Meta is everything a folder or a note carries besides its body.
//
// Tags are omitted when empty rather than written as an empty array, so a note that has
// none seals to the same bytes the browser would have produced for it.
type Meta struct {
	Name string   `json:"name"`
	Icon string   `json:"icon,omitempty"`
	Tags []string `json:"tags,omitempty"`
}

func EncryptMeta(key []byte, meta Meta, ref EntityRef) (Sealed, error) {
	plaintext, err := MarshalMeta(meta)
	if err != nil {
		return Sealed{}, err
	}

	return encrypt(key, plaintext, AAD(ref))
}

// MarshalMeta produces the bytes the browser would have produced for the same metadata.
//
// encoding/json escapes <, > and & by default and JSON.stringify does not, so a note called
// "R&D <draft>" would otherwise be sealed to different bytes depending on which side wrote
// it. Both forms decrypt and parse, but only one of them is the format already in the
// database, and a difference nothing checks is a difference that grows.
func MarshalMeta(meta Meta) ([]byte, error) {
	var out bytes.Buffer

	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)

	if err := encoder.Encode(meta); err != nil {
		return nil, fmt.Errorf("marshal meta: %w", err)
	}

	// Encode terminates the value with a newline; the browser does not.
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'}), nil
}

func DecryptMeta(key []byte, sealed Sealed, ref EntityRef) (Meta, error) {
	if len(key) == 0 {
		return Meta{}, ErrLocked
	}

	plaintext, err := decrypt(key, sealed, AAD(ref))
	if err != nil {
		return Meta{}, ErrLocked
	}

	var meta Meta
	if err := json.Unmarshal(plaintext, &meta); err != nil {
		return Meta{}, ErrLocked
	}

	return meta, nil
}

// EncryptContent seals a note body, padded so its stored size stops being a fingerprint.
func EncryptContent(key []byte, body string, ref EntityRef) (Sealed, error) {
	return encrypt(key, pad([]byte(body), PadBlock), AAD(ref))
}

func DecryptContent(key []byte, sealed Sealed, ref EntityRef) (string, error) {
	if len(key) == 0 {
		return "", ErrLocked
	}

	padded, err := decrypt(key, sealed, AAD(ref))
	if err != nil {
		return "", ErrLocked
	}

	body, err := unpad(padded)
	if err != nil {
		return "", ErrLocked
	}

	return string(body), nil
}

func join(prefix string, parts ...string) []byte {
	return []byte(prefix + "|" + strings.Join(parts, "|"))
}
