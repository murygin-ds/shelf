// Package app starts and stops the application: it initializes the configuration,
// the logger, the Postgres connection and the HTTP server, and handles graceful shutdown.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"shelf/internal/api"
	"shelf/internal/config"
	"shelf/internal/logger"
	"shelf/internal/storage/postgres"

	"go.uber.org/zap"
)

// Run starts the application and blocks until ctx is cancelled (a stop signal) or the HTTP server fails.
func Run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	log, err := logger.New(cfg.Log)
	if err != nil {
		return fmt.Errorf("init logger: %w", err)
	}

	// On macOS Sync to stdout returns an ioctl error — it carries no information, so it is dropped on purpose.
	defer func() { _ = log.Sync() }()

	log = log.With(zap.String("service", cfg.App.Name), zap.String("env", cfg.App.Env))
	log.Info("starting service")

	pool, err := postgres.NewPool(ctx, cfg.Postgres)
	if err != nil {
		return fmt.Errorf("init postgres: %w", err)
	}

	defer pool.Close()

	log.Info("connected to postgres",
		zap.String("host", cfg.Postgres.Host),
		zap.Int("port", cfg.Postgres.Port),
		zap.String("database", cfg.Postgres.Database),
	)

	router, err := api.NewRouter(api.Deps{Config: cfg, Logger: log, Pool: pool})
	if err != nil {
		return fmt.Errorf("init router: %w", err)
	}

	srv := &http.Server{
		Addr:              cfg.HTTP.Addr(),
		Handler:           router,
		ReadTimeout:       cfg.HTTP.ReadTimeout,
		ReadHeaderTimeout: cfg.HTTP.ReadTimeout,
		WriteTimeout:      cfg.HTTP.WriteTimeout,
		IdleTimeout:       cfg.HTTP.IdleTimeout,
	}

	srvErr := make(chan error, 1)

	go func() {
		log.Info("http server listening", zap.String("addr", srv.Addr))

		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			srvErr <- err
		}

		close(srvErr)
	}()

	select {
	case err := <-srvErr:
		if err != nil {
			return fmt.Errorf("http server: %w", err)
		}
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	// The request context is already cancelled by the signal, so shutdown uses an independent one.
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cfg.HTTP.ShutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown http server: %w", err)
	}

	log.Info("service stopped gracefully")

	return nil
}
