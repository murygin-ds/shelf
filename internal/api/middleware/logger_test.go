package middleware

import "testing"

// The access log is kept for weeks and read by whoever runs the service. A login in a query
// string would make it a directory of who works here, which is the one piece of plaintext
// the rest of the system goes to some trouble not to store.
func TestSecretsAreKeptOutOfTheLog(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"login=marta%40acme.dev": "login=[redacted]",
		"code=ABCDE-FGHJK":       "code=[redacted]",
		"cursor=42&limit=500":    "cursor=42&limit=500",
		"login=a&cursor=9":       "cursor=9&login=[redacted]",
		"":                       "",
		"%zz":                    "?",
		"Login=marta":            "Login=[redacted]",
	}

	for raw, want := range cases {
		if got := redactQuery(raw); got != want {
			t.Fatalf("redactQuery(%q) = %q, want %q", raw, got, want)
		}
	}
}
