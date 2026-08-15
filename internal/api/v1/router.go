// Package v1 registers the routes of the first API version.
package v1

import (
	"shelf/internal/api/middleware"
	authapi "shelf/internal/api/v1/auth"
	vaultapi "shelf/internal/api/v1/vault"
	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/ratelimit"
	"shelf/internal/storage/postgres"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Deps holds the dependencies of the v1 handlers.
type Deps struct {
	Logger *zap.Logger
	Pool   *pgxpool.Pool
	Auth   config.Auth
}

// Register attaches the v1 routes to the given group (usually /api).
func Register(rg *gin.RouterGroup, deps Deps) {
	group := rg.Group("/v1")

	// The auth service doubles as the token parser for every protected group, so it is
	// built once and shared rather than reconstructed per feature.
	authService := auth.NewService(postgres.NewAuthRepository(deps.Pool), deps.Auth, deps.Logger)
	authapi.NewHandler(authService, authLimits(deps.Auth.RateLimit), deps.Logger).RegisterRoutes(group)

	workspace := postgres.NewVaultRepository(deps.Pool)
	vaultService := vault.NewService(vault.Deps{
		Vaults:  workspace,
		Folders: workspace,
		Files:   workspace,
		Tree:    workspace,
		Logger:  deps.Logger,
	})

	protected := group.Group("", middleware.Auth(authService))
	vaultapi.NewHandler(vaultService, deps.Logger).RegisterRoutes(protected)
}

// authLimits builds the rate limiters. Disabled limits stay zero:
// the handler substitutes a no-op for them.
func authLimits(cfg config.RateLimit) authapi.Limits {
	if !cfg.Enabled {
		return authapi.Limits{}
	}

	return authapi.Limits{
		LoginIP:         ratelimit.New(cfg.LoginIP.Limit, cfg.LoginIP.Window),
		LoginAccount:    ratelimit.New(cfg.LoginAccount.Limit, cfg.LoginAccount.Window),
		RecoveryIP:      ratelimit.New(cfg.RecoveryIP.Limit, cfg.RecoveryIP.Window),
		RecoveryAccount: ratelimit.New(cfg.RecoveryAccount.Limit, cfg.RecoveryAccount.Window),
	}
}
