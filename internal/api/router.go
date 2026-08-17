// Package api assembles the root HTTP router of the application.
package api

import (
	"fmt"

	"shelf/internal/api/middleware"
	v1 "shelf/internal/api/v1"
	realtimeapi "shelf/internal/api/v1/realtime"
	"shelf/internal/config"
	"shelf/internal/web"

	// The generated package registers the swagger spec in its init, without which
	// /swagger/doc.json has nothing to serve.
	_ "shelf/docs"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	"go.uber.org/zap"
)

// Deps holds the dependencies the HTTP layer needs.
type Deps struct {
	Config *config.Config
	Logger *zap.Logger
	Pool   *pgxpool.Pool
}

// Paths of the service endpoints.
const (
	pathHealth  = "/health"
	pathReady   = "/ready"
	pathAPI     = "/api"
	pathSwagger = "/swagger"
)

// serverPrefixes are the paths that belong to the server rather than to the client
// router, so an unmatched request under them is a genuine 404 and not a page.
var serverPrefixes = []string{pathAPI, pathHealth, pathReady, pathSwagger}

// Router is the engine together with what the HTTP server cannot shut down on its own.
//
// http.Server.Shutdown neither closes hijacked connections nor waits for them, so the live
// sockets have to be closed by hand — and something has to hold them until then.
type Router struct {
	*gin.Engine

	closers []func()
}

// Close releases what NewRouter opened. Safe to call once, before the server shuts down.
func (r *Router) Close() {
	for _, closer := range r.closers {
		closer()
	}
}

// NewRouter builds the router with all middleware and routes.
func NewRouter(deps Deps) (*Router, error) {
	if deps.Config.App.IsLocal() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()

	// An empty list means "trust no proxy header" — the client IP comes from the connection.
	if err := engine.SetTrustedProxies(deps.Config.HTTP.TrustedProxies); err != nil {
		return nil, fmt.Errorf("set trusted proxies: %w", err)
	}

	engine.Use(
		middleware.RequestID(),
		middleware.Logger(deps.Logger, pathHealth, pathReady),
		middleware.Recovery(deps.Logger),
		middleware.SecurityHeaders(),
		middleware.CORS(deps.Config.HTTP),
		middleware.MaxBody(deps.Config.HTTP.MaxBodyBytes),
		// The socket outlives any ceiling that makes sense for a request, so it is exempt
		// rather than given a longer one.
		middleware.Deadline(deps.Config.HTTP.HandlerTimeout, pathAPI+"/v1"+realtimeapi.Path),
	)

	spa, err := web.NewSPA(deps.Config.HTTP.StaticCacheMaxAge)
	if err != nil {
		return nil, fmt.Errorf("load frontend bundle: %w", err)
	}

	if !spa.Built() {
		deps.Logger.Warn("frontend bundle is missing, only the API is served")
	}

	engine.NoRoute(spaFallback(spa))
	engine.NoMethod(methodNotAllowed)

	health := NewHealthHandler(deps.Pool, deps.Config.App.Name)
	engine.GET(pathHealth, health.Live)
	engine.GET(pathReady, health.Ready)

	// Swagger UI must not be exposed in production — it is enabled by the http.swagger_enabled flag.
	if deps.Config.HTTP.SwaggerEnabled {
		engine.GET(pathSwagger+"/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
	}

	api := engine.Group(pathAPI)
	hub := v1.Register(api, v1.Deps{
		Logger:   deps.Logger,
		Pool:     deps.Pool,
		Auth:     deps.Config.Auth,
		HTTP:     deps.Config.HTTP,
		Realtime: deps.Config.Realtime,
	})

	router := &Router{Engine: engine}
	if hub != nil {
		router.closers = append(router.closers, hub.Close)
	}

	return router, nil
}
