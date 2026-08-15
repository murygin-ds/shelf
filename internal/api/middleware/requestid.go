// Package middleware contains the shared HTTP middleware of the application.
package middleware

import (
	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// HeaderRequestID is the header carrying the end-to-end request identifier.
const HeaderRequestID = "X-Request-ID"

// ContextRequestID is the request id key in gin.Context.
const ContextRequestID = response.ContextRequestID

// RequestID sets the end-to-end request identifier: takes it from the header or generates a new one.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(HeaderRequestID)
		if id == "" {
			id = uuid.NewString()
		}

		c.Set(ContextRequestID, id)
		c.Header(HeaderRequestID, id)

		c.Next()
	}
}

// RequestIDFrom returns the request id of the current request.
func RequestIDFrom(c *gin.Context) string {
	return c.GetString(ContextRequestID)
}
