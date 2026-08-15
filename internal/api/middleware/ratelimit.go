package middleware

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

// HeaderRetryAfter tells the client how many seconds to wait before retrying.
const HeaderRetryAfter = "Retry-After"

// Limiter limits the request rate per key.
type Limiter interface {
	// Allow spends an attempt and returns the pause until the next one if the attempt was rejected.
	Allow(key string) (bool, time.Duration)
	// Refund gives a spent attempt back.
	Refund(key string)
}

// RateLimitByIP limits the request rate from a single address.
func RateLimitByIP(limiter Limiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		if ok, retryAfter := limiter.Allow(c.ClientIP()); !ok {
			TooManyRequests(c, retryAfter)
			return
		}

		c.Next()
	}
}

// TooManyRequests replies 429 with the Retry-After header.
func TooManyRequests(c *gin.Context, retryAfter time.Duration) {
	c.Header(HeaderRetryAfter, strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
	response.Fail(c, http.StatusTooManyRequests, response.CodeTooManyReqs, "too many requests, try again later")
}
