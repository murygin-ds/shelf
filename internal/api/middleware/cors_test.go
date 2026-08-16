package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shelf/internal/api/middleware"
	"shelf/internal/config"

	"github.com/gin-gonic/gin"
)

// An empty allow-list is the default and means same-origin only. The CORS library panics
// on it rather than accepting it, so this is the test that keeps the service starting.
func TestNoOriginsMeansNoCORS(t *testing.T) {
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(middleware.CORS(config.HTTP{}))
	router.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Origin", "https://elsewhere.example")

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want nothing at all", got)
	}
}

func TestAnAllowedOriginIsEchoed(t *testing.T) {
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(middleware.CORS(config.HTTP{AllowedOrigins: []string{"https://app.example"}}))
	router.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Origin", "https://app.example")

	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the configured origin", got)
	}
}

// The headers apply to the API as much as to the app: a JSON endpoint a browser can be
// tricked into framing or sniffing is as much a way in as an HTML one.
func TestSecurityHeadersAreSet(t *testing.T) {
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(middleware.SecurityHeaders())
	router.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	for header, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}

	policy := rec.Header().Get("Content-Security-Policy")

	// The two that matter most: nothing may load a script from elsewhere, and nothing may
	// frame a page whose whole job is to hold plaintext.
	// wasm is allowed on purpose and eval is not: Argon2id runs as a WebAssembly module,
	// and 'unsafe-eval' would re-open the door this policy exists to close.
	if strings.Contains(policy, "'unsafe-eval'") && !strings.Contains(policy, "'wasm-unsafe-eval'") {
		t.Fatalf("Content-Security-Policy %q allows eval outright", policy)
	}

	for _, directive := range []string{
		"script-src 'self' 'wasm-unsafe-eval'",
		"frame-ancestors 'none'",
	} {
		if !strings.Contains(policy, directive) {
			t.Fatalf("Content-Security-Policy %q is missing %q", policy, directive)
		}
	}
}
