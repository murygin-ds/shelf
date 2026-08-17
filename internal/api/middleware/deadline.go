package middleware

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
)

// Deadline puts a ceiling on how long one request may occupy the server.
//
// http.Server's WriteTimeout stops a slow response from holding a socket, but it does not
// reach the work behind it: a query that never comes back keeps its pool connection, and
// the pool is ten wide. Ten of those and the service answers nothing at all, without a
// single error in the log.
//
// The deadline rides on the request context, so every query started from a handler
// inherits it and pgx cancels the statement when it expires.
//
// skipPaths exempts the endpoints a ceiling makes no sense for. A websocket lives for as
// long as the tab does, and a deadline on its context would close it mid-session.
func Deadline(timeout time.Duration, skipPaths ...string) gin.HandlerFunc {
	if timeout <= 0 {
		return func(c *gin.Context) { c.Next() }
	}

	skip := make(map[string]struct{}, len(skipPaths))
	for _, path := range skipPaths {
		skip[path] = struct{}{}
	}

	return func(c *gin.Context) {
		if _, ok := skip[c.Request.URL.Path]; ok {
			c.Next()
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
		defer cancel()

		c.Request = c.Request.WithContext(ctx)

		c.Next()
	}
}
