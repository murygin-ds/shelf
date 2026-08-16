// Package auth contains the HTTP handlers of authentication.
package auth

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"shelf/internal/api/middleware"
	"shelf/internal/api/response"
	"shelf/internal/auth"
	"shelf/internal/ratelimit"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Service is the authentication business logic the handler serves.
type Service interface {
	middleware.TokenParser

	Register(ctx context.Context, in auth.RegisterInput, meta auth.ClientMeta) (*auth.User, auth.TokenPair, error)
	Prelogin(ctx context.Context, login string) (auth.Prelogin, error)
	Login(ctx context.Context, login string, authHash []byte, meta auth.ClientMeta) (*auth.User, auth.TokenPair, error)
	Refresh(ctx context.Context, refreshToken string, meta auth.ClientMeta) (auth.TokenPair, error)
	Logout(ctx context.Context, refreshToken string) error
	LogoutAll(ctx context.Context, userID int64) error
	User(ctx context.Context, userID int64) (*auth.User, error)
	Sessions(ctx context.Context, userID int64) ([]auth.Session, error)
	RevokeSession(ctx context.Context, userID, sessionID int64) error
	ChangePassword(ctx context.Context, userID int64, currentAuthHash []byte, in auth.CredentialsInput, meta auth.ClientMeta) (auth.TokenPair, error)
	RecoveryStart(ctx context.Context, login string, recoveryAuthHash []byte) (*auth.RecoveryChallenge, error)
	RecoveryComplete(ctx context.Context, recoveryToken string, in auth.CredentialsInput, meta auth.ClientMeta) (auth.TokenPair, error)
}

// Limits holds the rate limiters of the endpoints used to guess credentials.
// A zero field means "no limit".
type Limits struct {
	LoginIP middleware.Limiter
	// RegisterIP bounds account creation. Registering runs Argon2id twice at 64 MiB, so an
	// unbounded endpoint is a memory exhaustion primitive that needs no credentials at all.
	RegisterIP      middleware.Limiter
	LoginAccount    middleware.Limiter
	RecoveryIP      middleware.Limiter
	RecoveryAccount middleware.Limiter
}

func (l Limits) orUnlimited() Limits {
	if l.LoginIP == nil {
		l.LoginIP = ratelimit.Nop{}
	}

	if l.RegisterIP == nil {
		l.RegisterIP = ratelimit.Nop{}
	}

	if l.LoginAccount == nil {
		l.LoginAccount = ratelimit.Nop{}
	}

	if l.RecoveryIP == nil {
		l.RecoveryIP = ratelimit.Nop{}
	}

	if l.RecoveryAccount == nil {
		l.RecoveryAccount = ratelimit.Nop{}
	}

	return l
}

// Handler serves the /api/v1/auth routes.
type Handler struct {
	service Service
	limits  Limits
	log     *zap.Logger
}

// NewHandler creates the authentication handler.
func NewHandler(service Service, limits Limits, log *zap.Logger) *Handler {
	return &Handler{service: service, limits: limits.orUnlimited(), log: log}
}

// RegisterRoutes registers the routes of the /auth group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	group := rg.Group("/auth")

	group.POST("/register", middleware.RateLimitByIP(h.limits.RegisterIP), h.Register)
	group.POST("/prelogin", h.Prelogin)
	group.POST("/login", middleware.RateLimitByIP(h.limits.LoginIP), h.Login)
	group.POST("/refresh", h.Refresh)
	group.POST("/logout", h.Logout)
	group.POST("/recovery/start", middleware.RateLimitByIP(h.limits.RecoveryIP), h.RecoveryStart)
	group.POST("/recovery/complete", h.RecoveryComplete)

	protected := group.Group("", middleware.Auth(h.service))
	protected.GET("/me", h.Me)
	protected.GET("/keys", h.Keys)
	protected.POST("/password", h.ChangePassword)
	protected.POST("/logout-all", h.LogoutAll)
	protected.GET("/sessions", h.Sessions)
	protected.DELETE("/sessions/:id", h.RevokeSession)
}

// Register godoc
//
//	@Summary		Registration
//	@Description	Creates an account from the cryptographic material prepared by the client and opens a session.
//	@Description	The server never sees the password: the client derives the master key wrapping key and auth_hash from it.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		registerRequest	true	"Registration data"
//	@Success		201		{object}	SessionResponse
//	@Failure		409		{object}	response.ErrorResponse	"Login is already taken"
//	@Failure		422		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/register [post]
func (h *Handler) Register(c *gin.Context) {
	var req registerRequest
	if !bind(c, &req) {
		return
	}

	login := strings.TrimSpace(req.Login)
	if login == "" {
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation, "login must not be blank")
		return
	}

	created, pair, err := h.service.Register(c.Request.Context(), req.toDomain(login), clientMeta(c))
	if err != nil {
		if errors.Is(err, auth.ErrLoginTaken) {
			response.Fail(c, http.StatusConflict, response.CodeConflict, "login is already taken")
			return
		}

		h.fail(c, "register", err)

		return
	}

	response.Created(c, SessionResponse{User: user(created), Keys: keys(created.Keys), Tokens: tokens(pair)})
}

// Prelogin godoc
//
//	@Summary		Key derivation parameters
//	@Description	Returns the salt and the KDF parameters the client needs to compute auth_hash.
//	@Description	For an unknown login it returns plausible values so the endpoint does not reveal whether the account exists.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		preloginRequest	true	"Login"
//	@Success		200		{object}	PreloginResponse
//	@Failure		422		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/prelogin [post]
func (h *Handler) Prelogin(c *gin.Context) {
	var req preloginRequest
	if !bind(c, &req) {
		return
	}

	params, err := h.service.Prelogin(c.Request.Context(), req.Login)
	if err != nil {
		h.fail(c, "prelogin", err)
		return
	}

	response.OK(c, PreloginResponse{KDFSalt: params.KDFSalt, KDFParams: params.KDFParams})
}

// Login godoc
//
//	@Summary		Login
//	@Description	Verifies auth_hash and returns the wrapped keys together with a token pair.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		loginRequest	true	"Login and auth_hash"
//	@Success		200		{object}	SessionResponse
//	@Failure		401		{object}	response.ErrorResponse
//	@Failure		422		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/login [post]
func (h *Handler) Login(c *gin.Context) {
	var req loginRequest
	if !bind(c, &req) {
		return
	}

	// The per-address limit is already checked by the middleware. The per-account one is
	// applied only to a wrong answer, and deliberately after the credentials are checked:
	// spending it up front would let anybody who knows a login lock its owner out for the
	// window by guessing wrong twenty times, over and over.
	//
	// The cost of that ordering is that the account counter no longer saves the Argon2id
	// work — the per-address limit is what bounds that, and a distributed attack was never
	// bounded by punishing the account it was aimed at.
	account := accountKey(req.Login)

	found, pair, err := h.service.Login(c.Request.Context(), req.Login, req.AuthHash, clientMeta(c))
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			if ok, retryAfter := h.limits.LoginAccount.Allow(account); !ok {
				middleware.TooManyRequests(c, retryAfter)
				return
			}

			response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "invalid login or password")

			return
		}

		h.fail(c, "login", err)

		return
	}

	h.limits.LoginIP.Refund(c.ClientIP())

	response.OK(c, SessionResponse{User: user(found), Keys: keys(found.Keys), Tokens: tokens(pair)})
}

// Refresh godoc
//
//	@Summary		Token pair refresh
//	@Description	Exchanges a refresh token for a new pair. The token is single-use: presenting it again revokes all sessions.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		refreshRequest	true	"Refresh token"
//	@Success		200		{object}	TokensResponse
//	@Failure		401		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/refresh [post]
func (h *Handler) Refresh(c *gin.Context) {
	var req refreshRequest
	if !bind(c, &req) {
		return
	}

	pair, err := h.service.Refresh(c.Request.Context(), req.RefreshToken, clientMeta(c))
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrSessionNotFound):
			response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "refresh token is invalid or expired")
		case errors.Is(err, auth.ErrSessionReused):
			response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "refresh token was already used, all sessions revoked")
		default:
			h.fail(c, "refresh", err)
		}

		return
	}

	response.OK(c, tokens(pair))
}

// Logout godoc
//
//	@Summary		Logout
//	@Description	Revokes the session the refresh token belongs to.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body	refreshRequest	true	"Refresh token"
//	@Success		204
//	@Failure		422	{object}	response.ErrorResponse
//	@Router			/api/v1/auth/logout [post]
func (h *Handler) Logout(c *gin.Context) {
	var req refreshRequest
	if !bind(c, &req) {
		return
	}

	if err := h.service.Logout(c.Request.Context(), req.RefreshToken); err != nil {
		h.fail(c, "logout", err)
		return
	}

	response.NoContent(c)
}

// LogoutAll godoc
//
//	@Summary		Logout on every device
//	@Tags			auth
//	@Produce		json
//	@Security		BearerAuth
//	@Success		204
//	@Failure		401	{object}	response.ErrorResponse
//	@Router			/api/v1/auth/logout-all [post]
func (h *Handler) LogoutAll(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
		return
	}

	if err := h.service.LogoutAll(c.Request.Context(), userID); err != nil {
		h.fail(c, "logout all", err)
		return
	}

	response.NoContent(c)
}

// Me godoc
//
//	@Summary		Current user
//	@Tags			auth
//	@Produce		json
//	@Security		BearerAuth
//	@Success		200	{object}	UserResponse
//	@Failure		401	{object}	response.ErrorResponse
//	@Router			/api/v1/auth/me [get]
func (h *Handler) Me(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
		return
	}

	found, err := h.service.User(c.Request.Context(), userID)
	if err != nil {
		h.fail(c, "get user", err)
		return
	}

	response.OK(c, user(found))
}

// Keys godoc
//
//	@Summary		Cryptographic material of the user
//	@Description	Returns the wrapped keys: the client needs them after a restart while the access token is still alive.
//	@Tags			auth
//	@Produce		json
//	@Security		BearerAuth
//	@Success		200	{object}	KeysResponse
//	@Failure		401	{object}	response.ErrorResponse
//	@Router			/api/v1/auth/keys [get]
func (h *Handler) Keys(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
		return
	}

	found, err := h.service.User(c.Request.Context(), userID)
	if err != nil {
		h.fail(c, "get keys", err)
		return
	}

	response.OK(c, keys(found.Keys))
}

// ChangePassword godoc
//
//	@Summary		Password change
//	@Description	Accepts the master key re-encrypted with the new wrapping key. All sessions are revoked and the response carries a new token pair.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Security		BearerAuth
//	@Param			request	body		changePasswordRequest	true	"New authentication data"
//	@Success		200		{object}	TokensResponse
//	@Failure		401		{object}	response.ErrorResponse
//	@Failure		422		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/password [post]
func (h *Handler) ChangePassword(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
		return
	}

	var req changePasswordRequest
	if !bind(c, &req) {
		return
	}

	pair, err := h.service.ChangePassword(c.Request.Context(), userID, req.CurrentAuthHash, req.toDomain(), clientMeta(c))
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "current password is invalid")
			return
		}

		h.fail(c, "change password", err)

		return
	}

	response.OK(c, tokens(pair))
}

// RecoveryStart godoc
//
//	@Summary		Access recovery start
//	@Description	Verifies ownership of the recovery code and returns the master key wrapped with it
//	@Description	together with a short-lived token for completing the recovery.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		recoveryStartRequest	true	"Login and recovery code verifier"
//	@Success		200		{object}	RecoveryChallengeResponse
//	@Failure		401		{object}	response.ErrorResponse
//	@Failure		422		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/recovery/start [post]
func (h *Handler) RecoveryStart(c *gin.Context) {
	var req recoveryStartRequest
	if !bind(c, &req) {
		return
	}

	account := accountKey(req.Login)

	if ok, retryAfter := h.limits.RecoveryAccount.Allow(account); !ok {
		middleware.TooManyRequests(c, retryAfter)
		return
	}

	challenge, err := h.service.RecoveryStart(c.Request.Context(), req.Login, req.AuthHash)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "invalid login or recovery code")
			return
		}

		h.fail(c, "recovery start", err)

		return
	}

	h.limits.RecoveryAccount.Refund(account)
	h.limits.RecoveryIP.Refund(c.ClientIP())

	response.OK(c, RecoveryChallengeResponse{
		WrappedMasterKey: challenge.WrappedMasterKey,
		Nonce:            challenge.Nonce,
		RecoveryToken:    challenge.Token,
		ExpiresAt:        challenge.ExpiresAt,
	})
}

// RecoveryComplete godoc
//
//	@Summary		Access recovery completion
//	@Description	Sets the new authentication data using the token issued by recovery/start.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		recoveryCompleteRequest	true	"New authentication data"
//	@Success		200		{object}	TokensResponse
//	@Failure		401		{object}	response.ErrorResponse
//	@Failure		422		{object}	response.ErrorResponse
//	@Router			/api/v1/auth/recovery/complete [post]
func (h *Handler) RecoveryComplete(c *gin.Context) {
	var req recoveryCompleteRequest
	if !bind(c, &req) {
		return
	}

	pair, err := h.service.RecoveryComplete(c.Request.Context(), req.RecoveryToken, req.toDomain(), clientMeta(c))
	if err != nil {
		if errors.Is(err, auth.ErrInvalidToken) {
			response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "recovery token is invalid or expired")
			return
		}

		h.fail(c, "recovery complete", err)

		return
	}

	response.OK(c, tokens(pair))
}

// Sessions godoc
//
//	@Summary		Active sessions
//	@Tags			auth
//	@Produce		json
//	@Security		BearerAuth
//	@Success		200	{object}	DevicesResponse
//	@Failure		401	{object}	response.ErrorResponse
//	@Router			/api/v1/auth/sessions [get]
func (h *Handler) Sessions(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
		return
	}

	list, err := h.service.Sessions(c.Request.Context(), userID)
	if err != nil {
		h.fail(c, "list sessions", err)
		return
	}

	currentID, _ := middleware.SessionIDFrom(c)

	response.OK(c, devices(list, currentID))
}

// RevokeSession godoc
//
//	@Summary		Session revocation
//	@Tags			auth
//	@Produce		json
//	@Security		BearerAuth
//	@Param			id	path	int	true	"Session identifier"
//	@Success		204
//	@Failure		401	{object}	response.ErrorResponse
//	@Failure		404	{object}	response.ErrorResponse
//	@Router			/api/v1/auth/sessions/{id} [delete]
func (h *Handler) RevokeSession(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
		return
	}

	sessionID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.Fail(c, http.StatusBadRequest, response.CodeBadRequest, "session id must be an integer")
		return
	}

	if err := h.service.RevokeSession(c.Request.Context(), userID, sessionID); err != nil {
		if errors.Is(err, auth.ErrSessionNotFound) {
			response.Fail(c, http.StatusNotFound, response.CodeNotFound, "session not found")
			return
		}

		h.fail(c, "revoke session", err)

		return
	}

	response.NoContent(c)
}

// bind parses and validates the request body, replying to the client itself on error.
func bind(c *gin.Context, req any) bool {
	if err := c.ShouldBindJSON(req); err != nil {
		// A body that ran into the size cap is not a malformed one, and telling the caller
		// it is would send them looking in the wrong place.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.Fail(c, http.StatusRequestEntityTooLarge, response.CodeBadRequest,
				"the request body is too large")

			return false
		}

		response.FailValidation(c, err)

		return false
	}

	return true
}

// accountKey normalizes the login: the limit must not be bypassed by changing the case.
func accountKey(login string) string {
	return strings.ToLower(strings.TrimSpace(login))
}

func clientMeta(c *gin.Context) auth.ClientMeta {
	meta := auth.ClientMeta{UserAgent: c.Request.UserAgent()}

	if addr, err := netip.ParseAddr(c.ClientIP()); err == nil {
		meta.IP = addr
	}

	return meta
}

// fail logs an unexpected error and replies 500 without details.
func (h *Handler) fail(c *gin.Context, op string, err error) {
	middleware.LoggerFrom(c).Error("auth: "+op+" failed", zap.Error(err))
	response.Internal(c)
}
