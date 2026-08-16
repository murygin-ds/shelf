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
//
// An empty list is the default and means no cross-origin access at all: the binary serves
// the app it talks to, and the dev server proxies /api, so both are same-origin and the
// browser's own policy is the right answer. Sending no CORS headers is how you say that —
// gin-contrib/cors panics rather than accepting an empty allow-list, which is why this
// returns a pass-through instead of configuring it.
//
// Credentials are disabled for "*": browsers forbid that combination and the library
// panics on it too.
func CORS(cfg config.HTTP) gin.HandlerFunc {
	if len(cfg.AllowedOrigins) == 0 {
		return func(c *gin.Context) { c.Next() }
	}

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
