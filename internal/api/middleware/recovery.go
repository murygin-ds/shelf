package middleware

import (
	"errors"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"shelf/internal/api/response"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Recovery catches panics in handlers, logs the stack and replies 500 in the common error format.
func Recovery(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}

			reqLog := LoggerFrom(c)
			if reqLog == nil {
				reqLog = log
			}

			// A broken connection is not our fault, and there is no one left to reply to.
			if isBrokenPipe(rec) {
				reqLog.Warn("broken connection",
					zap.Any("panic", rec),
					zap.String("path", c.Request.URL.Path),
				)
				c.Abort()

				return
			}

			reqLog.Error("panic recovered",
				zap.Any("panic", rec),
				zap.String("method", c.Request.Method),
				zap.String("path", c.Request.URL.Path),
				zap.ByteString("stack", debug.Stack()),
			)

			response.Fail(c, http.StatusInternalServerError, response.CodeInternal, "internal server error")
		}()

		c.Next()
	}
}

func isBrokenPipe(rec any) bool {
	err, ok := rec.(error)
	if !ok {
		return false
	}

	var netErr *net.OpError
	if !errors.As(err, &netErr) {
		return false
	}

	var sysErr *os.SyscallError
	if !errors.As(netErr.Err, &sysErr) {
		return false
	}

	msg := strings.ToLower(sysErr.Error())

	return strings.Contains(msg, "broken pipe") || strings.Contains(msg, "connection reset by peer")
}
