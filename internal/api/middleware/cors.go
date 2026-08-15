package middleware

import (
	"net/http"
	"shelf/internal/config"
	"slices"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// CORS configures the cross-origin request policy.
// Credentials are disabled for "*": browsers forbid that combination and gin-contrib/cors panics on it.
func CORS(cfg config.HTTP) gin.HandlerFunc {
	allowAll := slices.Contains(cfg.AllowedOrigins, "*")

	return cors.New(cors.Config{
		AllowAllOrigins: allowAll,
		AllowOrigins: func() []string {
			if allowAll {
				return nil
			}

			return cfg.AllowedOrigins
		}(),
		AllowMethods: []string{
			http.MethodGet,
			http.MethodPost,
			http.MethodPut,
			http.MethodPatch,
			http.MethodDelete,
			http.MethodOptions,
		},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", HeaderRequestID},
		ExposeHeaders:    []string{"Content-Length", HeaderRequestID},
		AllowCredentials: !allowAll,
		MaxAge:           12 * time.Hour,
	})
}
