package api

import (
	"context"
	"net/http"
	"shelf/internal/api/middleware"
	"shelf/internal/api/response"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

const healthCheckTimeout = 2 * time.Second

// HealthResponse is the body returned by the health endpoints.
type HealthResponse struct {
	Status  string `json:"status"  example:"ok"`
	Service string `json:"service" example:"shelf-backend"`
}

// HealthHandler serves the liveness/readiness probes.
type HealthHandler struct {
	pool    *pgxpool.Pool
	service string
}

// NewHealthHandler creates the health check handler.
func NewHealthHandler(pool *pgxpool.Pool, service string) *HealthHandler {
	return &HealthHandler{pool: pool, service: service}
}

// Live godoc
//
//	@Summary		Liveness probe
//	@Description	Returns 200 while the process is alive. Does not check external dependencies.
//	@Tags			system
//	@Produce		json
//	@Success		200	{object}	api.HealthResponse
//	@Router			/health [get]
func (h *HealthHandler) Live(c *gin.Context) {
	response.OK(c, HealthResponse{Status: "ok", Service: h.service})
}

// Ready godoc
//
//	@Summary		Readiness probe
//	@Description	Checks that PostgreSQL is reachable. Returns 503 if the database is unavailable.
//	@Tags			system
//	@Produce		json
//	@Success		200	{object}	api.HealthResponse
//	@Failure		503	{object}	response.ErrorResponse
//	@Router			/ready [get]
func (h *HealthHandler) Ready(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), healthCheckTimeout)
	defer cancel()

	if err := h.pool.Ping(ctx); err != nil {
		middleware.LoggerFrom(c).Error("readiness check failed", zap.Error(err))
		response.FailReason(c, http.StatusServiceUnavailable, response.CodeInternal,
			response.ReasonDatabaseUnavailable, "database is unavailable")

		return
	}

	response.OK(c, HealthResponse{Status: "ok", Service: h.service})
}
