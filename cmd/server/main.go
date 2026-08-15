// Package main starts the HTTP server of the Shelf service.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"shelf/internal/app"
	"syscall"
)

//	@title	                   Shelf API
//	@version	               1.0
//	@description	           REST API of the Shelf service.

//	@contact.name	           Shelf Backend
//	@contact.email	           dmitr.murygin@gmail.com

//	@license.name	           Proprietary

//	@host		               localhost:8080
//	@schemes	               http https
//	@BasePath	               /

// @securityDefinitions.apikey	BearerAuth
// @in							header
// @name						Authorization
// @description				    JWT token in the format: Bearer {token}
func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	return app.Run(ctx)
}
