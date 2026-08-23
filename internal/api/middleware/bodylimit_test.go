package middleware_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shelf/internal/api/middleware"
	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

// A body that ran into the cap is not a malformed one, and the caller has to be able to
// tell the difference without reading English.
func TestOversizeBodyNamesItsCause(t *testing.T) {
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(middleware.MaxBody(8))
	router.POST("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("a", 64))))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusRequestEntityTooLarge, rec.Body)
	}

	var body response.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body, err)
	}

	if got := body.Error.Details[response.ReasonKey]; got != response.ReasonBodyTooLarge {
		t.Fatalf("reason = %q, want %q", got, response.ReasonBodyTooLarge)
	}
}
