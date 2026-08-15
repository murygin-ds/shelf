package middleware

import (
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const ContextLogger = "logger"

// Logger logs every request and puts a logger carrying request_id into the context,
// so that handlers write logs tied to a particular request.
// skipPaths keeps noisy endpoints (health probes, for example) out of the log.
func Logger(log *zap.Logger, skipPaths ...string) gin.HandlerFunc {
	skip := make(map[string]struct{}, len(skipPaths))
	for _, path := range skipPaths {
		skip[path] = struct{}{}
	}

	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		reqLog := log.With(zap.String("request_id", RequestIDFrom(c)))
		c.Set(ContextLogger, reqLog)

		c.Next()

		if _, ok := skip[path]; ok {
			return
		}

		status := c.Writer.Status()
		fields := []zap.Field{
			zap.String("method", c.Request.Method),
			zap.String("path", path),
			zap.String("query", query),
			zap.Int("status", status),
			zap.Int("size", c.Writer.Size()),
			zap.String("ip", c.ClientIP()),
			zap.String("user_agent", c.Request.UserAgent()),
			zap.Duration("latency", time.Since(start)),
		}

		if len(c.Errors) > 0 {
			fields = append(fields, zap.String("errors", c.Errors.ByType(gin.ErrorTypePrivate).String()))
		}

		switch {
		case status >= 500:
			reqLog.Error("http request", fields...)
		case status >= 400:
			reqLog.Warn("http request", fields...)
		default:
			reqLog.Info("http request", fields...)
		}
	}
}

// LoggerFrom takes the request logger out of the context. Returns zap.NewNop if there is none.
func LoggerFrom(c *gin.Context) *zap.Logger {
	value, ok := c.Get(ContextLogger)
	if !ok {
		return zap.NewNop()
	}

	log, ok := value.(*zap.Logger)
	if !ok {
		return zap.NewNop()
	}

	return log
}
