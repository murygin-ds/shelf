package auth_test

import (
	"errors"
	"strings"
	"testing"

	"shelf/internal/auth"
	"shelf/internal/config"
)

// The parameters are lowered on purpose: the tests need speed, not strength.
func testArgon2() config.Argon2 {
	return config.Argon2{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
}

func TestHashVerify(t *testing.T) {
	t.Parallel()

	hasher := auth.NewHasher(testArgon2())
	secret := []byte("client-auth-hash")

	encoded, err := hasher.Hash(secret)
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}

	if !strings.HasPrefix(encoded, "$argon2id$v=19$m=8192,t=1,p=1$") {
		t.Fatalf("Hash() = %q, want PHC-encoded argon2id", encoded)
	}

	ok, err := auth.Verify(secret, encoded)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}

	if !ok {
		t.Fatal("Verify() = false, want true for the same secret")
	}

	ok, err = auth.Verify([]byte("another-secret"), encoded)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}

	if ok {
		t.Fatal("Verify() = true, want false for a different secret")
	}
}

func TestHashUsesRandomSalt(t *testing.T) {
	t.Parallel()

	hasher := auth.NewHasher(testArgon2())
	secret := []byte("client-auth-hash")

	first, err := hasher.Hash(secret)
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}

	second, err := hasher.Hash(secret)
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}

	if first == second {
		t.Fatal("Hash() returned identical values, salt is not random")
	}
}

func TestVerifyRejectsMalformedHash(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"empty string":           "",
		"unknown algorithm":      "$argon2i$v=19$m=8192,t=1,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaA",
		"no parameters":          "$argon2id$v=19$c2FsdHNhbHRzYWx0c2E$aGFzaA",
		"unsupported version":    "$argon2id$v=16$m=8192,t=1,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaA",
		"invalid base64 in salt": "$argon2id$v=19$m=8192,t=1,p=1$!!!$aGFzaA",
	}

	for name, encoded := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			if _, err := auth.Verify([]byte("secret"), encoded); !errors.Is(err, auth.ErrInvalidHashFormat) {
				t.Fatalf("Verify() error = %v, want ErrInvalidHashFormat", err)
			}
		})
	}
}
