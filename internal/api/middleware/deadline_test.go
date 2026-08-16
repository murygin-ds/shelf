package middleware_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"shelf/internal/api/middleware"

	"github.com/gin-gonic/gin"
)

// The deadline has to reach the work, not merely the socket: a query that never returns
// keeps its pool connection, and the pool is ten wide.
func TestDeadlineReachesTheHandlerContext(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var deadlined error

	router := gin.New()
	router.Use(middleware.Deadline(20 * time.Millisecond))
	router.GET("/", func(c *gin.Context) {
		<-c.Request.Context().Done()
		deadlined = c.Request.Context().Err()
		c.Status(http.StatusOK)
	})

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	if !errors.Is(deadlined, context.DeadlineExceeded) {
		t.Fatalf("handler context ended with %v, want a deadline", deadlined)
	}
}

// Zero means no deadline, so a deployment that has not set one keeps working rather than
// cancelling every request instantly.
func TestNoDeadlineConfiguredLeavesTheContextAlone(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var hasDeadline bool

	router := gin.New()
	router.Use(middleware.Deadline(0))
	router.GET("/", func(c *gin.Context) {
		_, hasDeadline = c.Request.Context().Deadline()
		c.Status(http.StatusOK)
	})

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	if hasDeadline {
		t.Fatal("a zero timeout still set a deadline")
	}
}
