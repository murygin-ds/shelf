package envelope

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"fmt"
	"math/big"
)

const (
	// IdentityFormat is the first byte of both the public blob and the private bundle.
	IdentityFormat = 0x01

	// PublicKeyLength is an uncompressed P-256 point: 0x04 || x || y.
	PublicKeyLength = 65

	// SignatureLength is ECDSA r || s, 32 bytes each. WebCrypto produces and expects this
	// raw form, not the ASN.1 one crypto/ecdsa signs with by default.
	SignatureLength = 64
)

// SplitPublicBlob separates the two halves of the identity blob stored in users.public_key
// and in mcp_connectors.public_key. Both keys are P-256, and they are kept apart because
// reusing one EC key across ECDH and ECDSA is the kind of shortcut that breaks later.
func SplitPublicBlob(blob []byte) (seal, sign []byte, err error) {
	if len(blob) != 1+PublicKeyLength*2 {
		return nil, nil, fmt.Errorf("public key blob must be %d bytes, got %d", 1+PublicKeyLength*2, len(blob))
	}

	if blob[0] != IdentityFormat {
		return nil, nil, fmt.Errorf("unknown public key format %#x", blob[0])
	}

	return blob[1 : 1+PublicKeyLength], blob[1+PublicKeyLength:], nil
}

// ParsePrivateBundle reads the pair of PKCS#8 keys the browser packs into one blob:
// IdentityFormat, then each key behind a big-endian uint16 length, agreement key first.
func ParsePrivateBundle(bundle []byte) (*ecdh.PrivateKey, *ecdsa.PrivateKey, error) {
	if len(bundle) == 0 || bundle[0] != IdentityFormat {
		return nil, nil, fmt.Errorf("unknown identity bundle format")
	}

	sealPKCS8, next, err := readLengthPrefixed(bundle, 1)
	if err != nil {
		return nil, nil, err
	}

	signPKCS8, _, err := readLengthPrefixed(bundle, next)
	if err != nil {
		return nil, nil, err
	}

	// Both halves are id-ecPublicKey on the wire, so the agreement key parses as ECDSA and
	// is converted rather than being read as ECDH directly.
	sealKey, err := parseEC(sealPKCS8)
	if err != nil {
		return nil, nil, fmt.Errorf("parse agreement key: %w", err)
	}

	seal, err := sealKey.ECDH()
	if err != nil {
		return nil, nil, fmt.Errorf("convert agreement key: %w", err)
	}

	sign, err := parseEC(signPKCS8)
	if err != nil {
		return nil, nil, fmt.Errorf("parse signing key: %w", err)
	}

	return seal, sign, nil
}

// Verify checks a signature made by the browser, which emits r || s rather than ASN.1.
func Verify(authorPublicBlob, signature, payload []byte) bool {
	if len(signature) != SignatureLength {
		return false
	}

	_, signRaw, err := SplitPublicBlob(authorPublicBlob)
	if err != nil {
		return false
	}

	public, err := signingKey(signRaw)
	if err != nil {
		return false
	}

	digest := sha256.Sum256(payload)

	return ecdsa.Verify(public,
		digest[:],
		new(big.Int).SetBytes(signature[:SignatureLength/2]),
		new(big.Int).SetBytes(signature[SignatureLength/2:]),
	)
}

// signingKey reads the raw uncompressed point the browser exports. The parse rejects
// anything off the curve and the point at infinity, which is what closes the invalid-curve
// attack on the verifying side.
func signingKey(raw []byte) (*ecdsa.PublicKey, error) {
	public, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), raw)
	if err != nil {
		return nil, fmt.Errorf("import signing key: %w", err)
	}

	return public, nil
}

func parseEC(pkcs8 []byte) (*ecdsa.PrivateKey, error) {
	parsed, err := x509.ParsePKCS8PrivateKey(pkcs8)
	if err != nil {
		return nil, fmt.Errorf("parse pkcs8: %w", err)
	}

	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("expected an EC key, got %T", parsed)
	}

	return key, nil
}

func readLengthPrefixed(bundle []byte, offset int) ([]byte, int, error) {
	if offset+2 > len(bundle) {
		return nil, 0, fmt.Errorf("identity bundle is truncated")
	}

	length := int(binary.BigEndian.Uint16(bundle[offset:]))
	start := offset + 2

	if start+length > len(bundle) {
		return nil, 0, fmt.Errorf("identity bundle is truncated")
	}

	return bundle[start : start+length], start + length, nil
}

// Identity is the pair of P-256 keypairs an account carries. One agrees on keys, one signs;
// reusing a single EC key for both is the kind of shortcut that turns into a break later.
type Identity struct {
	Seal *ecdh.PrivateKey
	Sign *ecdsa.PrivateKey

	// PublicBlob is what goes into users.public_key, and what a fingerprint is taken over.
	PublicBlob []byte
}

// GenerateIdentity produces an account identity in the exact shape the browser produces,
// so that a connector is indistinguishable from a person to everything that reads a grant.
func GenerateIdentity() (*Identity, error) {
	seal, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate agreement key: %w", err)
	}

	sign, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate signing key: %w", err)
	}

	blob := make([]byte, 0, 1+PublicKeyLength*2)
	blob = append(blob, IdentityFormat)
	blob = append(blob, seal.PublicKey().Bytes()...)

	signPublic, err := sign.PublicKey.ECDH()
	if err != nil {
		return nil, fmt.Errorf("encode signing key: %w", err)
	}

	blob = append(blob, signPublic.Bytes()...)

	return &Identity{Seal: seal, Sign: sign, PublicBlob: blob}, nil
}

// MarshalPrivateBundle packs both private keys the way unwrapIdentity expects to find them:
// the format byte, then each PKCS#8 key behind a big-endian uint16 length, agreement first.
func (id *Identity) MarshalPrivateBundle() ([]byte, error) {
	seal, err := x509.MarshalPKCS8PrivateKey(id.Seal)
	if err != nil {
		return nil, fmt.Errorf("marshal agreement key: %w", err)
	}

	sign, err := x509.MarshalPKCS8PrivateKey(id.Sign)
	if err != nil {
		return nil, fmt.Errorf("marshal signing key: %w", err)
	}

	bundle := make([]byte, 0, 1+2+len(seal)+2+len(sign))
	bundle = append(bundle, IdentityFormat)
	bundle = appendLengthPrefixed(bundle, seal)
	bundle = appendLengthPrefixed(bundle, sign)

	return bundle, nil
}

// Fingerprint is the short, readable digest of a public blob. The server hands out public
// keys, so it can hand out its own; comparing fingerprints out of band is what closes that
// gap, and it is the only check a person can perform on the connector's identity.
func Fingerprint(publicBlob []byte) string {
	digest := sha256.Sum256(publicBlob)

	return group(base32(digest[:], fingerprintChars), fingerprintGroup, ' ')
}

func appendLengthPrefixed(dst, value []byte) []byte {
	return append(binary.BigEndian.AppendUint16(dst, uint16(len(value))), value...)
}

// The additional data of the two blobs that wrap an account's keys. A connector account has
// the same shape as a person's: a master key wrapped by something derived from a secret,
// and the identity bundle wrapped by that master key. For a person the outer secret is a
// passphrase run through Argon2id; for a connector it is the server's configured secret.
const (
	masterKeyAAD = "shelf/master-key/v1"
	identityAAD  = "shelf/identity/v1"
)

func WrapMasterKey(masterKey, wrappingKey []byte) (Sealed, error) {
	return encrypt(wrappingKey, masterKey, []byte(masterKeyAAD))
}

func UnwrapMasterKey(sealed Sealed, wrappingKey []byte) ([]byte, error) {
	return decrypt(wrappingKey, sealed, []byte(masterKeyAAD))
}

func WrapIdentity(bundle, masterKey []byte) (Sealed, error) {
	return encrypt(masterKey, bundle, []byte(identityAAD))
}

// UnwrapIdentity reassembles an identity from what the database holds: the public blob as
// stored, and the bundle sealed under the master key.
func UnwrapIdentity(publicBlob []byte, sealed Sealed, masterKey []byte) (*Identity, error) {
	if _, _, err := SplitPublicBlob(publicBlob); err != nil {
		return nil, err
	}

	bundle, err := decrypt(masterKey, sealed, []byte(identityAAD))
	if err != nil {
		return nil, fmt.Errorf("unwrap identity: %w", err)
	}

	seal, sign, err := ParsePrivateBundle(bundle)
	if err != nil {
		return nil, err
	}

	return &Identity{Seal: seal, Sign: sign, PublicBlob: publicBlob}, nil
}
