package middleware

import (
	"net/http"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

// MaxBody caps the size of a request body. gin imposes no limit of its own, and the
// batch endpoints accept enough ciphertext that an unbounded body is a real risk.
// A declared oversize body is rejected before it is read; a lying or chunked one is
// cut off mid-read by the reader.
func MaxBody(limit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > limit {
			response.FailReason(c, http.StatusRequestEntityTooLarge, response.CodeTooLarge,
				response.ReasonBodyTooLarge, "request body is too large")
			return
		}

		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}

		c.Next()
	}
}
