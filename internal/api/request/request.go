// Package request holds the binding helpers shared by the v1 handlers.
package request

import (
	"errors"
	"net/http"
	"strconv"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

// HeaderIfMatch carries the optimistic concurrency token on a content write.
const HeaderIfMatch = "If-Match"

// Bind decodes and validates a JSON body, answering the caller itself when it cannot.
// An oversize body is reported as such rather than as a parse failure, which is the
// difference between a user retrying with a smaller note and one retrying forever.
func Bind(c *gin.Context, req any) bool {
	err := c.ShouldBindJSON(req)
	if err == nil {
		return true
	}

	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		response.Fail(c, http.StatusRequestEntityTooLarge, response.CodeTooLarge, "request body is too large")
		return false
	}

	response.FailValidation(c, err)

	return false
}

// ID reads a positive int64 path parameter.
func ID(c *gin.Context, name string) (int64, bool) {
	value, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil || value <= 0 {
		response.FailWithDetails(c, http.StatusNotFound, response.CodeNotFound, "route not found",
			map[string]string{name: "invalid"})

		return 0, false
	}

	return value, true
}

// Query reads a non-negative int64 query parameter, falling back to a default when it is
// absent. A malformed value is refused rather than silently defaulted: a client asking for
// changes since "abc" would otherwise be handed the whole vault as if from scratch.
func Query(c *gin.Context, name string, fallback int64) (int64, bool) {
	raw := c.Query(name)
	if raw == "" {
		return fallback, true
	}

	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		response.FailWithDetails(c, http.StatusBadRequest, response.CodeBadRequest,
			"invalid query parameter", map[string]string{name: "invalid"})

		return 0, false
	}

	return value, true
}

// IfMatch reads the version the client believes it is overwriting. It is required: without
// it a client would silently clobber an edit it never saw, and the server cannot merge
// two ciphertexts it cannot read.
func IfMatch(c *gin.Context) (int64, bool) {
	raw := c.GetHeader(HeaderIfMatch)
	if raw == "" {
		response.Fail(c, http.StatusPreconditionRequired, response.CodeBadRequest,
			"If-Match with the current content sequence is required")

		return 0, false
	}

	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		response.Fail(c, http.StatusBadRequest, response.CodeBadRequest, "If-Match must be a content sequence")

		return 0, false
	}

	return value, true
}
