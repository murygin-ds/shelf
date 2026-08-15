// Package logger builds a *zap.Logger from the application configuration.
package logger

import (
	"fmt"
	"os"
	"shelf/internal/config"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Supported output formats.
const (
	FormatJSON    = "json"
	FormatConsole = "console"
)

// New creates a logger: JSON for environments with log aggregation, console for local development.
func New(cfg config.Log) (*zap.Logger, error) {
	level, err := zapcore.ParseLevel(cfg.Level)
	if err != nil {
		return nil, fmt.Errorf("parse log level %q: %w", cfg.Level, err)
	}

	encoderCfg := zap.NewProductionEncoderConfig()
	encoderCfg.TimeKey = "ts"
	encoderCfg.MessageKey = "msg"
	encoderCfg.EncodeTime = zapcore.ISO8601TimeEncoder
	encoderCfg.EncodeDuration = zapcore.StringDurationEncoder

	var encoder zapcore.Encoder
	switch cfg.Format {
	case FormatConsole:
		encoderCfg.EncodeLevel = zapcore.CapitalColorLevelEncoder
		encoder = zapcore.NewConsoleEncoder(encoderCfg)
	case FormatJSON:
		encoder = zapcore.NewJSONEncoder(encoderCfg)
	default:
		return nil, fmt.Errorf("unknown log format %q", cfg.Format)
	}

	core := zapcore.NewCore(encoder, zapcore.Lock(os.Stdout), level)

	return zap.New(core,
		zap.AddCaller(),
		zap.AddStacktrace(zapcore.ErrorLevel),
	), nil
}
