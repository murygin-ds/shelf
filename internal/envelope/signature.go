package envelope

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"strconv"
)

// RevisionPayload is what the author of a body signs.
//
// The ciphertext alone would not be enough: signing it bare would let a hostile server move
// a signed body onto a different note, or replay an old one as the current version, and the
// signature would still check out. So the digest covers the slot as well — which vault,
// which note, under which scope and version, at which sequence — and the nonce with it,
// because two versions with identical plaintext would otherwise share one signature.
func RevisionPayload(ref EntityRef, contentSeq int64, sealed Sealed) []byte {
	header := "shelf/sig/v1|" +
		strconv.FormatInt(ref.VaultID, 10) + "|" +
		ref.EntityID + "|" +
		ref.ScopeClientID + "|" +
		strconv.FormatInt(int64(ref.KeyVersion), 10) + "|" +
		strconv.FormatInt(contentSeq, 10) + "|"

	payload := make([]byte, 0, len(header)+len(sealed.Nonce)+len(sealed.Ciphertext))
	payload = append(payload, header...)
	payload = append(payload, sealed.Nonce...)

	return append(payload, sealed.Ciphertext...)
}

// SignRevision signs a body the connector is about to write.
//
// It is what makes "written by" a fact rather than a claim: view, comment and edit are one
// key, so any reader could otherwise produce ciphertext that decrypts, and no reader could
// tell the difference. A connector that wrote unsigned bodies would be indistinguishable
// from a server forging them.
//
// contentSeq is the sequence the write will land on, which is one past what the caller
// last saw — the same number the If-Match precondition carries.
func SignRevision(identity *Identity, ref EntityRef, contentSeq int64, sealed Sealed) ([]byte, error) {
	return Sign(identity.Sign, RevisionPayload(ref, contentSeq, sealed))
}

// Sign produces the raw r || s form WebCrypto reads. ecdsa.SignASN1 would produce DER,
// which every existing signature in this system is not.
func Sign(private *ecdsa.PrivateKey, payload []byte) ([]byte, error) {
	digest := sha256.Sum256(payload)

	r, s, err := ecdsa.Sign(rand.Reader, private, digest[:])
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}

	half := SignatureLength / 2

	signature := make([]byte, SignatureLength)
	r.FillBytes(signature[:half])
	s.FillBytes(signature[half:])

	return signature, nil
}
