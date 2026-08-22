package envelope

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
)

const (
	// NonceLength is what WebCrypto uses for AES-GCM and what the API validates.
	NonceLength = 12
	KeyLength   = 32
)

// Sealed is a ciphertext together with the nonce it was produced under. The two are stored
// in separate columns everywhere, which is why they travel as a pair rather than concatenated.
type Sealed struct {
	Ciphertext []byte
	Nonce      []byte
}

func encrypt(key, plaintext, aad []byte) (Sealed, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return Sealed{}, err
	}

	nonce := make([]byte, NonceLength)
	if _, err := rand.Read(nonce); err != nil {
		return Sealed{}, fmt.Errorf("read nonce: %w", err)
	}

	return Sealed{Ciphertext: gcm.Seal(nil, nonce, plaintext, aad), Nonce: nonce}, nil
}

// decrypt fails on any tampering, a ciphertext moved to a different slot included: the
// caller's additional data binds it to one entity, scope and key version.
func decrypt(key []byte, sealed Sealed, aad []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}

	if len(sealed.Nonce) != NonceLength {
		return nil, fmt.Errorf("nonce must be %d bytes, got %d", NonceLength, len(sealed.Nonce))
	}

	plaintext, err := gcm.Open(nil, sealed.Nonce, sealed.Ciphertext, aad)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}

	return plaintext, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != KeyLength {
		return nil, fmt.Errorf("content key must be %d bytes, got %d", KeyLength, len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}

	return gcm, nil
}
