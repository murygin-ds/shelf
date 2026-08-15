package config_test

import (
	config "shelf/internal/config"
	"testing"
)

func TestPostgresDSN(t *testing.T) {
	t.Parallel()

	cfg := config.Postgres{
		Host:     "localhost",
		Port:     5432,
		User:     "postgres",
		Password: "p@ss word",
		Database: "shelf",
		SSLMode:  "disable",
	}

	want := "postgres://postgres:p%40ss%20word@localhost:5432/shelf?sslmode=disable"
	if got := cfg.DSN(); got != want {
		t.Fatalf("DSN() = %q, want %q", got, want)
	}
}

func TestLoadDefaultsAndEnvOverride(t *testing.T) {
	t.Setenv(config.EnvConfigPath, "testdata/does-not-exist.yaml")
	t.Setenv("SHELF_HTTP_PORT", "9090")
	t.Setenv("SHELF_LOG_LEVEL", "warn")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.HTTP.Port != 9090 {
		t.Errorf("HTTP.Port = %d, want 9090", cfg.HTTP.Port)
	}

	if cfg.Log.Level != "warn" {
		t.Errorf("Log.Level = %q, want %q", cfg.Log.Level, "warn")
	}

	// A value that was not overridden must come from the defaults
	if cfg.App.Env != config.EnvLocal {
		t.Errorf("App.Env = %q, want %q", cfg.App.Env, config.EnvLocal)
	}
}
