package middleware

import (
	"maps"
	"net/url"
	"slices"
	"strings"
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
			zap.String("query", redactQuery(query)),
			zap.Int("status", status),
			zap.Int("size", c.Writer.Size()),
			zap.String("ip", c.ClientIP()),
			zap.String("user_agent", c.Request.UserAgent()),
			zap.Duration("latency", time.Since(start)),
		}

		// Without this a redacted lookup line says neither who asked nor what for, which
		// makes it useless in exactly the incident it was redacted for.
		if userID, ok := UserIDFrom(c); ok {
			fields = append(fields, zap.Int64("user_id", userID))
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

// secretParams are the query parameters whose values must not reach the log.
//
// A login is the one thing an attacker needs before guessing a password, and /users/lookup
// takes it in the query string — so an access log kept for a month would otherwise be a
// directory of who works here. The parameter names stay, because knowing which were used is
// what makes a log worth reading.
var secretParams = map[string]bool{
	"login": true, "email": true, "code": true, "token": true,
	"secret": true, "q": true, "query": true,
}

func redactQuery(raw string) string {
	if raw == "" {
		return ""
	}

	// ParseQuery returns what it could parse alongside the error, and gin serves the request
	// from exactly that. Dropping the whole field would let one bad escape erase the log
	// line for a request the server went on to answer.
	values, err := url.ParseQuery(raw)
	malformed := err != nil

	var out strings.Builder

	if malformed {
		out.WriteString("[malformed]")
	}

	for _, key := range slices.Sorted(maps.Keys(values)) {
		if out.Len() > 0 {
			out.WriteByte('&')
		}

		out.WriteString(url.QueryEscape(key))
		out.WriteByte('=')

		if secretParams[strings.ToLower(key)] {
			out.WriteString("[redacted]")
			continue
		}

		// Re-encoded: a decoded value containing & or = would otherwise be written as if it
		// were more parameters, and an unredacted login= could be forged inside one.
		out.WriteString(url.QueryEscape(strings.Join(values[key], ",")))
	}

	return out.String()
}
