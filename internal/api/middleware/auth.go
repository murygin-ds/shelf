package middleware

import (
	"net/http"
	"strings"

	"shelf/internal/api/response"
	"shelf/internal/auth"

	"github.com/gin-gonic/gin"
)

// Keys of the authenticated request data stored in gin.Context.
const (
	ContextUserID    = "user_id"
	ContextSessionID = "session_id"
)

const bearerPrefix = "Bearer "

// TokenParser validates an access token. Implemented by auth.Service.
type TokenParser interface {
	ParseAccess(token string) (*auth.Claims, error)
}

// Auth lets through only requests with a valid access token and puts the user
// and session identifiers into the context.
func Auth(parser TokenParser) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, bearerPrefix) {
			response.FailReason(c, http.StatusUnauthorized, response.CodeUnauthorized,
				response.ReasonAuthHeaderMissing, "authorization header is missing or malformed")
			return
		}

		claims, err := parser.ParseAccess(strings.TrimSpace(header[len(bearerPrefix):]))
		if err != nil {
			response.FailReason(c, http.StatusUnauthorized, response.CodeUnauthorized,
				response.ReasonTokenInvalid, "invalid or expired access token")
			return
		}

		userID, err := claims.UserID()
		if err != nil {
			response.FailReason(c, http.StatusUnauthorized, response.CodeUnauthorized,
				response.ReasonTokenInvalid, "invalid or expired access token")
			return
		}

		c.Set(ContextUserID, userID)
		c.Set(ContextSessionID, claims.SessionID)

		c.Next()
	}
}

// UserIDFrom returns the user identifier of the current request.
// The second value is false if the request did not pass through Auth.
func UserIDFrom(c *gin.Context) (int64, bool) {
	value, ok := c.Get(ContextUserID)
	if !ok {
		return 0, false
	}

	id, ok := value.(int64)

	return id, ok
}

// SessionIDFrom returns the session identifier of the current request.
func SessionIDFrom(c *gin.Context) (int64, bool) {
	value, ok := c.Get(ContextSessionID)
	if !ok {
		return 0, false
	}

	id, ok := value.(int64)

	return id, ok
}
