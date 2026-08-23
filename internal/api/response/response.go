// Package response defines the common format of HTTP responses and API errors.
package response

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

// Machine-readable error codes that end up in the response body.
const (
	CodeBadRequest   = "bad_request"
	CodeValidation   = "validation_error"
	CodeUnauthorized = "unauthorized"
	CodeForbidden    = "forbidden"
	CodeNotFound     = "not_found"
	CodeConflict     = "conflict"
	CodeTooLarge     = "payload_too_large"
	CodeTooManyReqs  = "too_many_requests"
	CodeInternal     = "internal_error"
)

// ContextRequestID is the request id key in gin.Context (duplicated from middleware to avoid an import cycle).
const ContextRequestID = "request_id"

// Error is the response body of a failed request.
type Error struct {
	Code      string            `json:"code"                 example:"not_found"`
	Message   string            `json:"message"              example:"resource not found"`
	Details   map[string]string `json:"details,omitempty"`
	RequestID string            `json:"request_id,omitempty" example:"1f8c1a5e-2b3d-4d6a-9c0e-5f5a5a7d1234"`
}

// ErrorResponse is the error envelope referenced by the swagger annotations of the handlers.
type ErrorResponse struct {
	Error Error `json:"error"`
}

// JSON writes a successful response with the given status.
func JSON(c *gin.Context, status int, body any) {
	c.JSON(status, body)
}

// OK writes a 200 OK response.
func OK(c *gin.Context, body any) {
	c.JSON(http.StatusOK, body)
}

// Created writes a 201 Created response.
func Created(c *gin.Context, body any) {
	c.JSON(http.StatusCreated, body)
}

// NoContent writes a 204 No Content response.
func NoContent(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// Fail aborts the handler chain and writes an error in the common format.
func Fail(c *gin.Context, status int, code, message string) {
	FailWithDetails(c, status, code, message, nil)
}

// FailWithDetails aborts the handler chain and writes an error with additional fields.
func FailWithDetails(c *gin.Context, status int, code, message string, details map[string]string) {
	c.AbortWithStatusJSON(status, ErrorResponse{
		Error: Error{
			Code:      code,
			Message:   message,
			Details:   details,
			RequestID: c.GetString(ContextRequestID),
		},
	})
}

// FailValidation unfolds a validator error into the details map: field -> violated rule.
func FailValidation(c *gin.Context, err error) {
	var validationErrs validator.ValidationErrors
	if !errors.As(err, &validationErrs) {
		// Anything that is not a validator error is a malformed body, and encoding/json
		// describes those by naming the Go type it was decoding into. That tells the caller
		// nothing they can act on and tells an attacker the shape of the server.
		_ = c.Error(err)

		Fail(c, http.StatusBadRequest, CodeBadRequest, "the request body is not valid JSON")

		return
	}

	details := make(map[string]string, len(validationErrs))
	for _, fieldErr := range validationErrs {
		details[fieldErr.Field()] = fieldErr.Tag()
	}

	FailWithDetails(c, http.StatusUnprocessableEntity, CodeValidation, "request validation failed", details)
}

// Internal writes a 500 without details: they stay in the logs.
func Internal(c *gin.Context) {
	FailReason(c, http.StatusInternalServerError, CodeInternal, ReasonInternal, "internal server error")
}
