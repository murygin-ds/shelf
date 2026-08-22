package mcp

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

// The redirect is where an authorization code is sent and where the consent screen navigates
// afterwards. Registration takes no credential, so this check is the only thing between a
// stranger and either script on the vault's origin or the code in somebody else's hands.
func TestRedirectsThatMustNeverRegister(t *testing.T) {
	for _, raw := range []string{
		"javascript:alert(document.domain)",
		"JavaScript:alert(1)",
		"data:text/html,<script>fetch('//evil')</script>",
		"vbscript:msgbox(1)",
		"file:///etc/passwd",
		"http://evil.example.com/callback",
		"http://127.0.0.1.evil.com/callback",
		"https://claude.ai/cb#fragment",
		"https:///nohost",
		"",
		"::not a url",
	} {
		if err := usableRedirect(raw); err == nil {
			t.Errorf("%q was accepted as a redirect_uri", raw)
		}
	}
}

func TestRedirectsThatMustRegister(t *testing.T) {
	for _, raw := range []string{
		"https://claude.ai/api/mcp/auth_callback",
		// RFC 8252: a native client binds a port it cannot know in advance.
		"http://localhost/callback",
		"http://localhost:53219/callback",
		"http://127.0.0.1:8123/callback",
	} {
		if err := usableRedirect(raw); err != nil {
			t.Errorf("%q was refused: %v", raw, err)
		}
	}
}

// Registered exactly, except on the loopback where the port is whatever the client got.
func TestRedirectMatching(t *testing.T) {
	registered := []string{
		"https://claude.ai/api/mcp/auth_callback",
		// A native client registers both spellings, because only the port is ignored.
		"http://localhost/callback",
		"http://127.0.0.1/callback",
	}

	for _, candidate := range []string{
		"https://claude.ai/api/mcp/auth_callback",
		"http://localhost:53219/callback",
		"http://127.0.0.1:9000/callback",
	} {
		if !allowedRedirect(registered, candidate) {
			t.Errorf("%q did not match what was registered", candidate)
		}
	}

	for _, candidate := range []string{
		"https://claude.ai/api/mcp/auth_callback/../evil",
		"https://evil.example.com/api/mcp/auth_callback",
		"http://localhost:53219/other",
		"https://localhost/callback",
		// The two loopback spellings are not interchangeable: a client registers the one it
		// will use, and widening this would accept a redirect nobody declared.
		"http://[::1]:9000/callback",
	} {
		if allowedRedirect(registered, candidate) {
			t.Errorf("%q matched a registration it should not have", candidate)
		}
	}
}

// Only S256. "plain" would let whoever saw the challenge redeem the code, which is the whole
// attack PKCE exists to stop.
func TestPKCEVerification(t *testing.T) {
	verifier := "a-verifier-long-enough-to-be-one-0123456789abcdef"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	if !verifies(verifier, challenge) {
		t.Fatal("the correct verifier did not verify")
	}

	for name, pair := range map[string][2]string{
		"a different verifier": {"something-else-entirely-0123456789abcdefghij", challenge},
		"the plain challenge":  {verifier, verifier},
		"an empty verifier":    {"", challenge},
		"an empty challenge":   {verifier, ""},
		"padded base64":        {verifier, base64.StdEncoding.EncodeToString(sum[:])},
	} {
		if verifies(pair[0], pair[1]) {
			t.Errorf("%s verified", name)
		}
	}
}
