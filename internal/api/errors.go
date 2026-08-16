package api

import (
	"net/http"
	"strings"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

func notFound(c *gin.Context) {
	response.Fail(c, http.StatusNotFound, response.CodeNotFound, "route not found")
}

func methodNotAllowed(c *gin.Context) {
	response.Fail(c, http.StatusMethodNotAllowed, response.CodeBadRequest, "method not allowed")
}

// spaFallback sends unmatched page requests to the client router and keeps everything
// under a server-owned prefix on the JSON error format.
func spaFallback(spa http.Handler) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			notFound(c)
			return
		}

		for _, prefix := range serverPrefixes {
			if strings.HasPrefix(c.Request.URL.Path, prefix) {
				notFound(c)
				return
			}
		}

		spa.ServeHTTP(c.Writer, c.Request)
	}
}
