// Package v1 registers the routes of the first API version.
package v1

import (
	"net/http"

	"shelf/internal/access"
	"shelf/internal/api/middleware"
	accessapi "shelf/internal/api/v1/access"
	authapi "shelf/internal/api/v1/auth"
	mcpapi "shelf/internal/api/v1/mcp"
	realtimeapi "shelf/internal/api/v1/realtime"
	vaultapi "shelf/internal/api/v1/vault"
	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/mcp"
	"shelf/internal/ratelimit"
	"shelf/internal/realtime"
	"shelf/internal/storage/postgres"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Deps holds the dependencies of the v1 handlers.
type Deps struct {
	// Root is where routes that must answer at the host's root are mounted: the OAuth
	// discovery documents live at /.well-known, which a client reads before it has any
	// notion of an API version.
	Root     gin.IRouter
	Logger   *zap.Logger
	Pool     *pgxpool.Pool
	Auth     config.Auth
	HTTP     config.HTTP
	Realtime config.Realtime
	MCP      config.MCP
}

// Register attaches the v1 routes to the given group (usually /api). It returns the live
// session hub, which the caller has to close: the HTTP server will not do it.
// The hub is nil when the socket is disabled.
func Register(rg *gin.RouterGroup, deps Deps) *realtime.Hub {
	group := rg.Group("/v1")

	// The auth service doubles as the token parser for every protected group, so it is
	// built once and shared rather than reconstructed per feature.
	authService := auth.NewService(postgres.NewAuthRepository(deps.Pool), deps.Auth, deps.Logger)
	authapi.NewHandler(authService, authLimits(deps.Auth.RateLimit), deps.Logger).RegisterRoutes(group)

	// What this build will actually do, so the client can offer only what exists. Without it
	// a feature turned off in the configuration looks to the browser exactly like a feature
	// that is broken — a 404 on a route it had no way to know was never mounted.
	group.GET("/features", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"connector": deps.MCP.Enabled,
			"realtime":  deps.Realtime.Enabled,
		})
	})

	// The hub is built before the repositories so it can hear about a commit, and told
	// about the services afterwards, when they exist. A nil announcer is silence: with the
	// socket off, nothing is announced and the clients keep polling.
	var (
		hub       *realtime.Hub
		announcer postgres.Announcer
	)

	if deps.Realtime.Enabled {
		hub = realtime.NewHub(deps.Realtime, deps.Logger)
		announcer = hub
	}

	workspace := postgres.NewVaultRepository(deps.Pool, announcer)
	vaultService := vault.NewService(vault.Deps{
		Vaults:    workspace,
		Folders:   workspace,
		Files:     workspace,
		Tree:      workspace,
		Sync:      workspace,
		Rekeys:    workspace,
		Audit:     workspace,
		Graph:     workspace,
		Revisions: workspace,
		Shares:    workspace,
		CRDT:      workspace,
		Logger:    deps.Logger,
	})

	accessRepo := postgres.NewAccessRepository(deps.Pool, announcer)
	accessService := access.NewService(access.Deps{
		Repo:   accessRepo,
		Groups: accessRepo,
		Nodes:  workspace,
		Logger: deps.Logger,
	})

	protected := group.Group("", middleware.Auth(authService))

	workspaceHandler := vaultapi.NewHandler(vaultService, shareLookupLimit(deps.Auth.RateLimit), deps.Logger)
	workspaceHandler.RegisterRoutes(protected)
	workspaceHandler.RegisterPublicRoutes(group)
	accessapi.NewHandler(accessService, inviteLookupLimit(deps.Auth.RateLimit), deps.Logger).
		RegisterRoutes(group, protected)

	// Mounted only when the connector is configured: a server that was never meant to hold a
	// key should not advertise the way to give it one.
	if deps.MCP.Enabled {
		mcpRepo := postgres.NewMCPRepository(deps.Pool, announcer)

		mcpService := mcp.NewService(mcp.Deps{
			Repo:    mcpRepo,
			Tokens:  mcpRepo,
			OAuth:   mcpRepo,
			Members: accessRepo,
			Remover: accessRepo,
			Vaults:  vaultService,
			Live:    liveSessions(hub),
			Hasher:  auth.NewHasher(deps.Auth.Argon2),
			Config:  deps.MCP,
			Logger:  deps.Logger,
		})

		mcpapi.NewHandler(mcpService, deps.Logger).RegisterRoutes(protected)

		// Mounted outside the bearer middleware the rest of the API uses: an MCP credential
		// is not an access token, and making the two interchangeable would turn a connector
		// credential into a way into somebody's account.
		mcpapi.NewTransport(mcpService, deps.MCP.PublicBaseURL, deps.Logger).RegisterRoutes(group)

		oauth := mcpapi.NewOAuth(mcpService, deps.MCP.PublicBaseURL,
			oauthLimit(deps.Auth.RateLimit), deps.Logger)
		oauth.RegisterRoutes(group, protected)

		if deps.Root != nil {
			oauth.RegisterDiscovery(deps.Root)
		}

		deps.Logger.Warn("the MCP connector is enabled: vaults connected to it are readable by this server",
			zap.String("public_base_url", deps.MCP.PublicBaseURL))
	}

	if hub == nil {
		return nil
	}

	// Registered outside the protected group: a browser cannot put an Authorization header
	// on a websocket, so the token comes in the first frame instead.
	session := realtime.Session{Tokens: authService, Workspace: vaultService, Users: authService}
	realtimeapi.NewHandler(hub, session, deps.HTTP, deps.Logger).RegisterRoutes(group)

	return hub
}

// oauthLimit throttles dynamic client registration, the one connector endpoint that writes
// without a credential.
func oauthLimit(cfg config.RateLimit) middleware.Limiter {
	if !cfg.Enabled {
		return ratelimit.Nop{}
	}

	return ratelimit.New(cfg.OAuthIP.Limit, cfg.OAuthIP.Window)
}

// liveSessions hands the connector the hub, or nothing when the socket is off. A typed nil
// would satisfy the interface and then panic on the first call, so the nil is explicit.
func liveSessions(hub *realtime.Hub) mcp.Live {
	if hub == nil {
		return nil
	}

	return hub
}

// inviteLookupLimit throttles the anonymous invite lookup. A resolved code hands the
// attempt back, so only failed guesses spend the counter and a team onboarding several
// people from one office never runs into it.
func inviteLookupLimit(cfg config.RateLimit) middleware.Limiter {
	if !cfg.Enabled {
		return ratelimit.Nop{}
	}

	return ratelimit.New(cfg.InviteIP.Limit, cfg.InviteIP.Window)
}

// shareLookupLimit throttles the anonymous share lookup on the same terms as the invite
// one: a resolved link hands the attempt back, so a note passed round an office does not
// lock its own readers out.
func shareLookupLimit(cfg config.RateLimit) middleware.Limiter {
	if !cfg.Enabled {
		return ratelimit.Nop{}
	}

	return ratelimit.New(cfg.ShareIP.Limit, cfg.ShareIP.Window)
}

// authLimits builds the rate limiters. Disabled limits stay zero:
// the handler substitutes a no-op for them.
func authLimits(cfg config.RateLimit) authapi.Limits {
	if !cfg.Enabled {
		return authapi.Limits{}
	}

	return authapi.Limits{
		RegisterIP:      ratelimit.New(cfg.RegisterIP.Limit, cfg.RegisterIP.Window),
		LoginIP:         ratelimit.New(cfg.LoginIP.Limit, cfg.LoginIP.Window),
		LoginAccount:    ratelimit.New(cfg.LoginAccount.Limit, cfg.LoginAccount.Window),
		RecoveryIP:      ratelimit.New(cfg.RecoveryIP.Limit, cfg.RecoveryIP.Window),
		RecoveryAccount: ratelimit.New(cfg.RecoveryAccount.Limit, cfg.RecoveryAccount.Window),
	}
}
