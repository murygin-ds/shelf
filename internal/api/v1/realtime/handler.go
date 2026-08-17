// Package realtime exposes the live editing socket over HTTP.
package realtime

import (
	"shelf/internal/config"
	"shelf/internal/realtime"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Path is where the socket lives. It is exported so the router can exempt it from the
// handler deadline, which would otherwise close every session after a few seconds.
const Path = "/realtime"

// Handler upgrades a request into a live session.
type Handler struct {
	hub     *realtime.Hub
	session realtime.Session
	origins []string
	log     *zap.Logger
}

// NewHandler wires the socket endpoint. The origin list mirrors the CORS one: a websocket
// handshake is not subject to CORS, so the check has to be made here or not at all. An
// empty list leaves the library's default, which is same-origin.
func NewHandler(hub *realtime.Hub, session realtime.Session, cfg config.HTTP, log *zap.Logger) *Handler {
	return &Handler{hub: hub, session: session, origins: cfg.AllowedOrigins, log: log}
}

// RegisterRoutes attaches the endpoint. It is registered without the auth middleware: a
// browser cannot set an Authorization header on a websocket, so the token arrives in the
// first frame instead.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET(Path, h.Serve)
}

// Serve upgrades the connection and hands it to the hub.
//
// The frames themselves are documented in the README rather than here: swagger describes
// request and response bodies, and a socket has neither.
//
// @Summary  Live editing socket
// @Tags     realtime
// @Success  101 {string} string "switching protocols"
// @Router   /realtime [get]
func (h *Handler) Serve(c *gin.Context) {
	// The server's ReadTimeout and WriteTimeout need no undoing here: net/http clears the
	// connection's deadlines as part of hijacking it. The handler deadline does need
	// undoing, and that is done in the router by exempting this path.
	ws, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		OriginPatterns: h.origins,
	})
	if err != nil {
		// Accept has already written its own status by this point.
		h.log.Debug("realtime upgrade refused", zap.Error(err))
		return
	}

	defer func() { _ = ws.CloseNow() }()

	h.hub.Serve(c.Request.Context(), ws, h.session)
}
