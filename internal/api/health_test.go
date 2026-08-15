package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"shelf/internal/api"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestHealthLive(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.GET("/health", api.NewHealthHandler(nil, "shelf-backend").Live)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body api.HealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}

	if body.Status != "ok" || body.Service != "shelf-backend" {
		t.Fatalf("body = %+v, want status=ok service=shelf-backend", body)
	}
}
