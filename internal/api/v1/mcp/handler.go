// Package mcp exposes the connector: the endpoints that hand this server a vault's key and
// take it back. The MCP transport itself is served elsewhere; this is only the consent.
package mcp

import (
	"context"
	"errors"
	"net/http"

	"shelf/internal/api/middleware"
	"shelf/internal/api/request"
	"shelf/internal/api/response"
	"shelf/internal/mcp"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Service is the slice of the connector service this handler drives.
type Service interface {
	Enable(ctx context.Context, actorID, vaultID int64, role vault.Role) (*mcp.Connector, error)
	Admit(ctx context.Context, actorID, vaultID int64, keys []mcp.SealedKey) (*mcp.Connector, error)
	Disable(ctx context.Context, actorID, vaultID int64) ([]int64, error)
	Status(ctx context.Context, actorID, vaultID int64) (*mcp.Connector, error)
}

// Handler serves the connector endpoints.
type Handler struct {
	service Service
	log     *zap.Logger
}

// NewHandler creates the handler.
func NewHandler(service Service, log *zap.Logger) *Handler {
	return &Handler{service: service, log: log}
}

// RegisterRoutes attaches the connector routes. They are mounted only when the connector is
// enabled in the configuration, so a server that was never meant to hold a key does not
// advertise the way to give it one.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	connector := rg.Group("/vaults/:id/mcp")
	// Two steps on purpose: the browser cannot seal a key to a public key that does not
	// exist yet, so the identity comes first and the key follows.
	connector.POST("/identity", h.Enable)
	connector.POST("", h.Admit)
	connector.GET("", h.Status)
	connector.DELETE("", h.Disable)
}

// Enable mints a connector identity for the vault.
//
//	@Summary	Create the connector identity for a vault
//	@Tags		mcp
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int				true	"vault id"
//	@Param		request	body		enableRequest	true	"what the connector may do"
//	@Success	201		{object}	ConnectorResponse
//	@Failure	403		{object}	response.ErrorResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/mcp/identity [post]
func (h *Handler) Enable(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req enableRequest
	if !request.Bind(c, &req) {
		return
	}

	connector, err := h.service.Enable(c.Request.Context(), userID, vaultID, roleOf(req.Role))
	if err != nil {
		h.fail(c, "enable connector", err)

		return
	}

	c.JSON(http.StatusCreated, connectorResponse(connector))
}

// Admit hands the connector the scope keys sealed to it.
//
//	@Summary	Give the connector its keys
//	@Tags		mcp
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int				true	"vault id"
//	@Param		request	body		admitRequest	true	"scope keys sealed to the connector"
//	@Success	200		{object}	ConnectorResponse
//	@Failure	403		{object}	response.ErrorResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/mcp [post]
func (h *Handler) Admit(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req admitRequest
	if !request.Bind(c, &req) {
		return
	}

	connector, err := h.service.Admit(c.Request.Context(), userID, vaultID, req.keys())
	if err != nil {
		h.fail(c, "admit connector", err)

		return
	}

	c.JSON(http.StatusOK, connectorResponse(connector))
}

// Status reports the connector on a vault.
//
//	@Summary	Read the connector on a vault
//	@Tags		mcp
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	ConnectorResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/mcp [get]
func (h *Handler) Status(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	connector, err := h.service.Status(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "read connector", err)

		return
	}

	c.JSON(http.StatusOK, connectorResponse(connector))
}

// Disable removes the connector.
//
//	@Summary	Remove the connector from a vault
//	@Tags		mcp
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	DisabledResponse
//	@Failure	403	{object}	response.ErrorResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/mcp [delete]
func (h *Handler) Disable(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	scopes, err := h.service.Disable(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "disable connector", err)

		return
	}

	c.JSON(http.StatusOK, DisabledResponse{ScopesAwaitingRotation: scopes})
}

// target reads the caller and the vault from the request.
func (h *Handler) target(c *gin.Context) (userID, vaultID int64, ok bool) {
	userID, ok = middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication is required")

		return 0, 0, false
	}

	vaultID, ok = request.ID(c, "id")
	if !ok {
		return 0, 0, false
	}

	return userID, vaultID, true
}

// fail maps the domain errors onto the response format. A vault the caller cannot see is a
// 404 rather than a refusal, on the same terms as the rest of the API.
func (h *Handler) fail(c *gin.Context, op string, err error) {
	switch {
	case errors.Is(err, vault.ErrNotFound), errors.Is(err, mcp.ErrNotFound):
		response.Fail(c, http.StatusNotFound, response.CodeNotFound, "not found")
	case errors.Is(err, mcp.ErrOwnerRequired):
		response.Fail(c, http.StatusForbidden, response.CodeForbidden,
			"only the owner of a vault may connect it")
	case errors.Is(err, mcp.ErrRoleInvalid):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"a connector may be an editor or a viewer")
	case errors.Is(err, mcp.ErrExists):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"this vault already has a connector")
	case errors.Is(err, vault.ErrScopeMismatch):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"a key was sealed against a scope outside this vault")
	default:
		middleware.LoggerFrom(c).Error("connector handler failed", zap.String("op", op), zap.Error(err))
		response.Internal(c)
	}
}
