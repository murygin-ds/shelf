package envelope

import (
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
)

// SealFormat is the first byte of every sealed box, so the layout can be replaced later
// without guessing what an old row holds.
const SealFormat = 0x01

// Box is anonymous public-key encryption: an ephemeral P-256 keypair agrees with the
// recipient's agreement key, HKDF turns the shared secret into an AES-256-GCM key, and the
// ephemeral public key rides along so the recipient can repeat the agreement.
//
// This is how every scope key reaches a member, a group, an invite — and a connector.
type Box struct {
	// Blob is SealFormat || ephemeral public key || ciphertext, as stored in a wrapped_key column.
	Blob  []byte
	Nonce []byte
}

func Seal(recipientPublicRaw, payload []byte, info string) (Box, error) {
	recipient, err := ecdh.P256().NewPublicKey(recipientPublicRaw)
	if err != nil {
		return Box{}, fmt.Errorf("import recipient key: %w", err)
	}

	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return Box{}, fmt.Errorf("generate ephemeral key: %w", err)
	}

	nonce := make([]byte, NonceLength)
	if _, err := rand.Read(nonce); err != nil {
		return Box{}, fmt.Errorf("read nonce: %w", err)
	}

	key, err := agree(ephemeral, recipient, nonce, info)
	if err != nil {
		return Box{}, err
	}

	gcm, err := newGCM(key)
	if err != nil {
		return Box{}, err
	}

	ephemeralPublic := ephemeral.PublicKey().Bytes()

	blob := make([]byte, 0, 1+len(ephemeralPublic))
	blob = append(blob, SealFormat)
	blob = append(blob, ephemeralPublic...)

	return Box{Blob: gcm.Seal(blob, nonce, payload, []byte(info)), Nonce: nonce}, nil
}

func Open(recipient *ecdh.PrivateKey, box Box, info string) ([]byte, error) {
	if len(box.Blob) <= 1+PublicKeyLength {
		return nil, fmt.Errorf("sealed box is truncated")
	}

	if box.Blob[0] != SealFormat {
		return nil, fmt.Errorf("unknown sealed box format %#x", box.Blob[0])
	}

	if len(box.Nonce) != NonceLength {
		return nil, fmt.Errorf("nonce must be %d bytes, got %d", NonceLength, len(box.Nonce))
	}

	ephemeral, err := ecdh.P256().NewPublicKey(box.Blob[1 : 1+PublicKeyLength])
	if err != nil {
		return nil, fmt.Errorf("import ephemeral key: %w", err)
	}

	key, err := agree(recipient, ephemeral, box.Nonce, info)
	if err != nil {
		return nil, err
	}

	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}

	payload, err := gcm.Open(nil, box.Nonce, box.Blob[1+PublicKeyLength:], []byte(info))
	if err != nil {
		return nil, fmt.Errorf("open sealed box: %w", err)
	}

	return payload, nil
}

// The ephemeral keypair already makes the agreed key unique per box, so reusing the nonce
// as the HKDF salt costs nothing and keeps the stored shape identical to every other blob.
func agree(private *ecdh.PrivateKey, public *ecdh.PublicKey, nonce []byte, info string) ([]byte, error) {
	shared, err := private.ECDH(public)
	if err != nil {
		return nil, fmt.Errorf("agree: %w", err)
	}

	key, err := hkdf.Key(sha256.New, shared, nonce, info, KeyLength)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	return key, nil
}
