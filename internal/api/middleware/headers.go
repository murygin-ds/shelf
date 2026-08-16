package middleware

import "github.com/gin-gonic/gin"

// contentPolicy is deliberately narrow.
//
// Everything this app serves is its own: one bundle, self-hosted fonts, no CDN and no
// third-party script. A cross-site script here would not merely deface a page — it would
// read the master key out of memory and the plaintext of every note the reader has open,
// which is the one failure the whole design exists to prevent. So there is nothing to
// loosen the policy for.
//
// `frame-ancestors 'none'` covers what X-Frame-Options used to, and is kept alongside it
// because some proxies still strip one and not the other.
const contentPolicy = "default-src 'self'; " +
	// 'wasm-unsafe-eval' permits compiling WebAssembly and nothing else — it does not
	// re-admit eval() of JavaScript. Argon2id runs as wasm (hash-wasm), and without this
	// the passphrase cannot be derived at all: the sign-in screen fails on a CSP violation.
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; " +
	"font-src 'self'; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'"

// SecurityHeaders sets the response headers a browser needs to hold up its end.
//
// They apply to the API as well as the app: a JSON endpoint that a browser can be tricked
// into rendering, framing or sniffing is as much a way in as an HTML one.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.Writer.Header()

		header.Set("Content-Security-Policy", contentPolicy)
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		// A share link carries its secret in the fragment, which is never sent — but the
		// path is, and the referrer of an outbound click should not carry it either.
		header.Set("Referrer-Policy", "no-referrer")
		// Nothing here needs a camera, a microphone or a location.
		header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")

		c.Next()
	}
}
