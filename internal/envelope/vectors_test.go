package envelope

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// The browser wrote these; this package has to match them rather than the other way round.
// Regenerate with: cd web && npx vite-node scripts/gen-vectors.ts
const vectorsPath = "../../testdata/crypto-vectors.json"

// goVectorsPath goes the other way: what this package seals, opened by the browser in
// web/src/crypto/vectors.test.ts. Round-tripping within one implementation proves nothing
// about the other, and "Go writes a note the browser cannot read" is the expensive bug.
const goVectorsPath = "../../testdata/crypto-vectors-go.json"

var update = flag.Bool("update", false, "rewrite testdata/crypto-vectors-go.json")

type b64 []byte

func (v *b64) UnmarshalJSON(raw []byte) error {
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return err
	}

	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}

	*v = decoded

	return nil
}

func (v b64) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.StdEncoding.EncodeToString(v))
}

type vectorRef struct {
	VaultID       int64      `json:"vault_id"`
	Entity        EntityType `json:"entity"`
	EntityID      string     `json:"entity_id"`
	ScopeClientID string     `json:"scope_client_id"`
	KeyVersion    int32      `json:"key_version"`
}

// The two structs hold the same fields in the same order; only the json tags differ, and a
// conversion ignores those.
func (r vectorRef) ref() EntityRef { return EntityRef(r) }

type vectors struct {
	Version int `json:"version"`
	Key     b64 `json:"key_b64"`

	AAD []struct {
		Ref      vectorRef `json:"ref"`
		Expected b64       `json:"expected_b64"`
	} `json:"aad"`

	SealInfo []struct {
		ScopeClientID string `json:"scope_client_id"`
		KeyVersion    int32  `json:"key_version"`
		Expected      string `json:"expected"`
	} `json:"seal_info"`

	Pad []struct {
		Input    b64 `json:"input_b64"`
		Block    int `json:"block"`
		Expected b64 `json:"expected_b64"`
	} `json:"pad"`

	MetaJSON []struct {
		Meta     Meta   `json:"meta"`
		Expected string `json:"expected"`
	} `json:"meta_json"`

	AEAD []struct {
		Key        b64 `json:"key_b64"`
		AAD        b64 `json:"aad_b64"`
		Plaintext  b64 `json:"plaintext_b64"`
		Ciphertext b64 `json:"ciphertext_b64"`
		Nonce      b64 `json:"nonce_b64"`
	} `json:"aead"`

	EnvelopeMeta []struct {
		Ref        vectorRef `json:"ref"`
		Meta       Meta      `json:"meta"`
		Ciphertext b64       `json:"ciphertext_b64"`
		Nonce      b64       `json:"nonce_b64"`
	} `json:"envelope_meta"`

	EnvelopeContent []struct {
		Ref        vectorRef `json:"ref"`
		Body       string    `json:"body"`
		Ciphertext b64       `json:"ciphertext_b64"`
		Nonce      b64       `json:"nonce_b64"`
	} `json:"envelope_content"`

	SealedBox []struct {
		Info       string `json:"info"`
		PublicBlob b64    `json:"recipient_public_blob_b64"`
		Bundle     b64    `json:"recipient_bundle_b64"`
		Payload    b64    `json:"payload_b64"`
		Blob       b64    `json:"blob_b64"`
		Nonce      b64    `json:"nonce_b64"`
	} `json:"sealed_box"`

	Fingerprint []struct {
		PublicBlob b64    `json:"public_blob_b64"`
		Expected   string `json:"expected"`
	} `json:"fingerprint"`

	RevisionSignature []struct {
		PublicBlob b64       `json:"public_blob_b64"`
		Ref        vectorRef `json:"ref"`
		ContentSeq int64     `json:"content_seq"`
		Ciphertext b64       `json:"ciphertext_b64"`
		Nonce      b64       `json:"nonce_b64"`
		Payload    b64       `json:"payload_b64"`
		Signature  b64       `json:"signature_b64"`
	} `json:"revision_signature"`
}

func load(t *testing.T) vectors {
	t.Helper()

	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}

	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}

	if v.Version != 1 {
		t.Fatalf("vectors are version %d, this test reads version 1", v.Version)
	}

	return v
}

func TestAADMatchesBrowser(t *testing.T) {
	for _, c := range load(t).AAD {
		t.Run(string(c.Ref.Entity), func(t *testing.T) {
			if got := AAD(c.Ref.ref()); !bytes.Equal(got, c.Expected) {
				t.Errorf("AAD = %q, browser produces %q", got, c.Expected)
			}
		})
	}
}

func TestSealInfoMatchesBrowser(t *testing.T) {
	for _, c := range load(t).SealInfo {
		if got := SealInfo(c.ScopeClientID, c.KeyVersion); got != c.Expected {
			t.Errorf("SealInfo = %q, browser produces %q", got, c.Expected)
		}
	}
}

func TestPadMatchesBrowser(t *testing.T) {
	for _, c := range load(t).Pad {
		got := pad(c.Input, c.Block)

		if !bytes.Equal(got, c.Expected) {
			t.Errorf("pad(%d bytes) produced %d bytes, browser produces %d",
				len(c.Input), len(got), len(c.Expected))

			continue
		}

		back, err := unpad(got)
		if err != nil {
			t.Errorf("unpad: %v", err)
		} else if !bytes.Equal(back, c.Input) {
			t.Errorf("unpad(pad(x)) != x")
		}
	}
}

func TestMetaJSONMatchesBrowser(t *testing.T) {
	for _, c := range load(t).MetaJSON {
		got, err := MarshalMeta(c.Meta)
		if err != nil {
			t.Fatalf("marshal meta: %v", err)
		}

		if string(got) != c.Expected {
			t.Errorf("MarshalMeta = %s, browser produces %s", got, c.Expected)
		}
	}
}

func TestOpensWhatTheBrowserSealed(t *testing.T) {
	v := load(t)

	for _, c := range v.AEAD {
		got, err := decrypt(c.Key, Sealed{Ciphertext: c.Ciphertext, Nonce: c.Nonce}, c.AAD)
		if err != nil {
			t.Fatalf("decrypt: %v", err)
		}

		if !bytes.Equal(got, c.Plaintext) {
			t.Errorf("decrypt = %q, want %q", got, c.Plaintext)
		}
	}

	for _, c := range v.EnvelopeMeta {
		got, err := DecryptMeta(v.Key, Sealed{Ciphertext: c.Ciphertext, Nonce: c.Nonce}, c.Ref.ref())
		if err != nil {
			t.Fatalf("DecryptMeta: %v", err)
		}

		if got.Name != c.Meta.Name || got.Icon != c.Meta.Icon || len(got.Tags) != len(c.Meta.Tags) {
			t.Errorf("DecryptMeta = %+v, want %+v", got, c.Meta)
		}
	}

	for _, c := range v.EnvelopeContent {
		got, err := DecryptContent(v.Key, Sealed{Ciphertext: c.Ciphertext, Nonce: c.Nonce}, c.Ref.ref())
		if err != nil {
			t.Fatalf("DecryptContent: %v", err)
		}

		if got != c.Body {
			t.Errorf("DecryptContent = %q, want %q", got, c.Body)
		}
	}
}

// A ciphertext moved to another slot must fail. This is the property the additional data
// exists for, and the one a mismatched AAD string would silently destroy.
func TestRejectsCiphertextMovedToAnotherSlot(t *testing.T) {
	v := load(t)

	for _, c := range v.EnvelopeContent {
		elsewhere := c.Ref.ref()
		elsewhere.EntityID = "00000000-0000-4000-8000-000000000000"

		_, err := DecryptContent(v.Key, Sealed{Ciphertext: c.Ciphertext, Nonce: c.Nonce}, elsewhere)
		if err == nil {
			t.Fatal("a body opened under another entity id")
		}

		wrongVersion := c.Ref.ref()
		wrongVersion.KeyVersion++

		if _, err := DecryptContent(v.Key, Sealed{Ciphertext: c.Ciphertext, Nonce: c.Nonce}, wrongVersion); err == nil {
			t.Fatal("a body opened under another key version")
		}
	}
}

func TestOpensSealedBoxFromBrowser(t *testing.T) {
	for _, c := range load(t).SealedBox {
		seal, _, err := ParsePrivateBundle(c.Bundle)
		if err != nil {
			t.Fatalf("parse bundle: %v", err)
		}

		got, err := Open(seal, Box{Blob: c.Blob, Nonce: c.Nonce}, c.Info)
		if err != nil {
			t.Fatalf("open sealed box: %v", err)
		}

		if !bytes.Equal(got, c.Payload) {
			t.Errorf("sealed box carried %x, want %x", got, c.Payload)
		}

		// The info string names the scope, so a box replayed into another one must not open.
		if _, err := Open(seal, Box{Blob: c.Blob, Nonce: c.Nonce}, c.Info+"x"); err == nil {
			t.Error("a sealed box opened under the wrong info string")
		}
	}
}

func TestFingerprintMatchesBrowser(t *testing.T) {
	for _, c := range load(t).Fingerprint {
		if got := Fingerprint(c.PublicBlob); got != c.Expected {
			t.Errorf("Fingerprint = %q, browser produces %q", got, c.Expected)
		}
	}
}

func TestVerifiesBrowserSignature(t *testing.T) {
	for _, c := range load(t).RevisionSignature {
		sealed := Sealed{Ciphertext: c.Ciphertext, Nonce: c.Nonce}

		if got := RevisionPayload(c.Ref.ref(), c.ContentSeq, sealed); !bytes.Equal(got, c.Payload) {
			t.Errorf("RevisionPayload differs from the browser's")
		}

		if !Verify(c.PublicBlob, c.Signature, c.Payload) {
			t.Fatal("a signature the browser made did not verify")
		}

		// The sequence is inside the digest, so an old body cannot be replayed as current.
		replayed := RevisionPayload(c.Ref.ref(), c.ContentSeq+1, sealed)
		if Verify(c.PublicBlob, c.Signature, replayed) {
			t.Error("a signature verified at a sequence it was not made for")
		}
	}
}

// TestWriteGoVectors is the other direction: it seals with this package so the browser can
// try to open it. Run with -update to regenerate, and commit the result.
func TestWriteGoVectors(t *testing.T) {
	if !*update {
		t.Skip("run with -update to regenerate testdata/crypto-vectors-go.json")
	}

	v := load(t)

	identity, err := GenerateIdentity()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}

	bundle, err := identity.MarshalPrivateBundle()
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}

	ref := v.EnvelopeContent[0].Ref
	body := "Written by Go, opened by the browser.\n\nR&D <draft> — ёжик, 日本語.\n"
	meta := Meta{Name: "From the connector", Icon: "terminal", Tags: []string{"mcp", "a&b"}}

	sealedMeta, err := EncryptMeta(v.Key, meta, ref.ref())
	if err != nil {
		t.Fatalf("encrypt meta: %v", err)
	}

	sealedBody, err := EncryptContent(v.Key, body, ref.ref())
	if err != nil {
		t.Fatalf("encrypt content: %v", err)
	}

	const contentSeq = 43

	signature, err := SignRevision(identity, ref.ref(), contentSeq, sealedBody)
	if err != nil {
		t.Fatalf("sign revision: %v", err)
	}

	sealPublic, _, err := SplitPublicBlob(identity.PublicBlob)
	if err != nil {
		t.Fatalf("split public blob: %v", err)
	}

	info := SealInfo(ref.ScopeClientID, ref.KeyVersion)

	box, err := Seal(sealPublic, v.Key, info)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	out := map[string]any{
		"version": 1,
		"note":    "Generated by go test ./internal/envelope -update. The browser must open all of it.",
		"key_b64": b64(v.Key),
		"ref":     ref,
		"envelope_meta": map[string]any{
			"meta": meta, "ciphertext_b64": b64(sealedMeta.Ciphertext), "nonce_b64": b64(sealedMeta.Nonce),
		},
		"envelope_content": map[string]any{
			"body": body, "ciphertext_b64": b64(sealedBody.Ciphertext), "nonce_b64": b64(sealedBody.Nonce),
		},
		"sealed_box": map[string]any{
			"info": info, "payload_b64": b64(v.Key),
			"recipient_public_blob_b64": b64(identity.PublicBlob),
			"recipient_bundle_b64":      b64(bundle),
			"blob_b64":                  b64(box.Blob), "nonce_b64": b64(box.Nonce),
		},
		"fingerprint": map[string]any{
			"public_blob_b64": b64(identity.PublicBlob), "expected": Fingerprint(identity.PublicBlob),
		},
		"revision_signature": map[string]any{
			"public_blob_b64": b64(identity.PublicBlob),
			"content_seq":     contentSeq,
			"ciphertext_b64":  b64(sealedBody.Ciphertext), "nonce_b64": b64(sealedBody.Nonce),
			"signature_b64": b64(signature),
		},
	}

	encoded, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	if err := os.WriteFile(goVectorsPath, append(encoded, '\n'), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Logf("wrote %s", filepath.Clean(goVectorsPath))
}
