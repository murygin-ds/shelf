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
func Deadline(timeout time.Duration) gin.HandlerFunc {
	if timeout <= 0 {
		return func(c *gin.Context) { c.Next() }
	}

	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
		defer cancel()

		c.Request = c.Request.WithContext(ctx)

		c.Next()
	}
}
