package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

const spaBody = "<!doctype html>"

func newFallbackRouter(t *testing.T) *gin.Engine {
	t.Helper()

	gin.SetMode(gin.TestMode)

	spa := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(spaBody))
	})

	router := gin.New()
	router.NoRoute(spaFallback(spa))
	router.NoMethod(methodNotAllowed)

	return router
}

func TestFallbackServesTheAppShell(t *testing.T) {
	t.Parallel()

	router := newFallbackRouter(t)

	paths := []string{"/", "/signin", "/v/1/n/42", "/invite", "/deeply/nested/client/route"}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
			}

			if rec.Body.String() != spaBody {
				t.Fatalf("body = %q, want the app shell", rec.Body.String())
			}
		})
	}
}

func TestFallbackKeepsServerPathsOnJSON(t *testing.T) {
	t.Parallel()

	router := newFallbackRouter(t)

	// A path the client router owns must never shadow a missing API route: the caller
	// would otherwise parse HTML as a JSON payload.
	paths := []string{"/api/v1/nope", "/api", "/health/extra", "/ready/extra", "/swagger/doc.json"}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusNotFound, rec.Body)
			}

			var body response.ErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal body %s: %v", rec.Body, err)
			}

			if body.Error.Code != response.CodeNotFound {
				t.Fatalf("code = %q, want %q", body.Error.Code, response.CodeNotFound)
			}

			if got := body.Error.Details[response.ReasonKey]; got != response.ReasonRouteNotFound {
				t.Fatalf("reason = %q, want %q", got, response.ReasonRouteNotFound)
			}
		})
	}
}

func TestFallbackRejectsNonReadMethods(t *testing.T) {
	t.Parallel()

	router := newFallbackRouter(t)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			t.Parallel()

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(method, "/signin", nil))

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusNotFound, rec.Body)
			}
		})
	}
}

func TestFallbackAnswersHead(t *testing.T) {
	t.Parallel()

	router := newFallbackRouter(t)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/signin", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestAKnownPathWithTheWrongMethodSaysSo(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.HandleMethodNotAllowed = true
	router.GET("/api/v1/vaults", func(c *gin.Context) { c.Status(http.StatusOK) })
	router.NoMethod(methodNotAllowed)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/vaults", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusMethodNotAllowed, rec.Body)
	}

	var body response.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal body %s: %v", rec.Body, err)
	}

	// The code stays bad_request, which on its own reads as a malformed payload: the
	// reason is what tells the caller they aimed the wrong verb at a route that exists.
	if got := body.Error.Details[response.ReasonKey]; got != response.ReasonMethodNotAllowed {
		t.Fatalf("reason = %q, want %q", got, response.ReasonMethodNotAllowed)
	}
}
