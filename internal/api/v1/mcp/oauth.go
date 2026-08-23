package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"shelf/internal/api/middleware"
	"shelf/internal/api/request"
	"shelf/internal/api/response"
	"shelf/internal/mcp"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// The OAuth paths. They live under the API prefix so that an unmatched one is a JSON 404
// rather than the SPA, and the discovery documents that point at them live at the root
// because that is where a client looks first.
const (
	oauthPrefix       = "/oauth"
	registerPath      = oauthPrefix + "/register"
	authorizePath     = oauthPrefix + "/authorize"
	tokenPath         = oauthPrefix + "/token"
	protectedResource = "/.well-known/oauth-protected-resource"
	authorizationMeta = "/.well-known/oauth-authorization-server"
	// consentRoute is the client route that asks the person. It cannot be a server-rendered
	// form: the security headers set form-action 'none', so a form posted from this origin
	// would be blocked by the browser rather than by anything here.
	consentRoute = "/connect"
)

// OAuthService is the slice of the connector service the OAuth endpoints drive.
type OAuthService interface {
	RegisterClient(ctx context.Context, name string, redirects []string) (*mcp.Client, error)
	Client(ctx context.Context, clientID string) (*mcp.Client, error)
	Authorize(ctx context.Context, actorID, vaultID int64, clientID, redirectURI, challenge string) (string, error)
	Exchange(ctx context.Context, clientID, code, verifier, redirectURI string) (*mcp.Grant, error)
	Refresh(ctx context.Context, clientID, refresh string) (*mcp.Grant, error)
}

// OAuth serves the authorization server Claude expects to find in front of a connector.
type OAuth struct {
	service OAuthService
	base    string
	// registerLimit throttles the one endpoint that writes a row without a credential.
	registerLimit middleware.Limiter
	log           *zap.Logger
}

// NewOAuth creates the handler.
func NewOAuth(service OAuthService, publicBaseURL string, registerLimit middleware.Limiter, log *zap.Logger) *OAuth {
	return &OAuth{
		service:       service,
		base:          strings.TrimSuffix(publicBaseURL, "/"),
		registerLimit: registerLimit,
		log:           log,
	}
}

// RegisterDiscovery mounts the two metadata documents at the root of the host.
//
// They answer without a credential on purpose: their whole job is to tell a client that has
// none where to get one.
func (o *OAuth) RegisterDiscovery(rg gin.IRouter) {
	rg.GET(protectedResource, o.ProtectedResource)
	// Claude probes the path-suffixed form first when the challenge carries no pointer.
	rg.GET(protectedResource+"/api/v1"+Path, o.ProtectedResource)
	rg.GET(authorizationMeta, o.AuthorizationServer)
}

// RegisterRoutes mounts the flow. Consent is the only step that needs an account, because it
// is the only step where a person decides something.
func (o *OAuth) RegisterRoutes(open, protected *gin.RouterGroup) {
	open.POST(registerPath, middleware.RateLimitByIP(o.registerLimit), o.Register)
	open.GET(authorizePath, o.Consent)
	// The consent screen has to name who is asking, and a registration is public metadata
	// the client itself supplied.
	open.GET(oauthPrefix+"/client", o.ClientInfo)
	open.POST(tokenPath, o.Token)

	protected.POST(authorizePath, o.Approve)
}

// ProtectedResource is RFC 9728 metadata.
//
//	@Summary	OAuth protected resource metadata
//	@Tags		mcp
//	@Produce	json
//	@Success	200	{object}	map[string]any
//	@Router		/.well-known/oauth-protected-resource [get]
func (o *OAuth) ProtectedResource(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		// Must equal the URL the person typed into Claude, byte for byte, which is why it
		// comes from configuration and not from the Host header.
		"resource":                 o.base + "/api/v1" + Path,
		"authorization_servers":    []string{o.base},
		"scopes_supported":         scopes,
		"bearer_methods_supported": []string{"header"},
	})
}

// AuthorizationServer is RFC 8414 metadata.
//
//	@Summary	OAuth authorization server metadata
//	@Tags		mcp
//	@Produce	json
//	@Success	200	{object}	map[string]any
//	@Router		/.well-known/oauth-authorization-server [get]
func (o *OAuth) AuthorizationServer(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"issuer":                                o.base,
		"authorization_endpoint":                o.base + "/api/v1" + authorizePath,
		"token_endpoint":                        o.base + "/api/v1" + tokenPath,
		"registration_endpoint":                 o.base + "/api/v1" + registerPath,
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      scopes,
	})
}

var scopes = []string{mcp.ScopeRead, mcp.ScopeWrite, mcp.ScopeOffline}

// Register is RFC 7591 dynamic client registration.
//
//	@Summary	Register an OAuth client
//	@Tags		mcp
//	@Accept		json
//	@Produce	json
//	@Param		request	body		registerRequest	true	"client metadata"
//	@Success	201		{object}	registerResponse
//	@Router		/api/v1/oauth/register [post]
func (o *OAuth) Register(c *gin.Context) {
	var req registerRequest
	if !request.Bind(c, &req) {
		return
	}

	client, err := o.service.RegisterClient(c.Request.Context(), req.ClientName, req.RedirectURIs)
	if err != nil {
		o.oauthError(c, http.StatusBadRequest, err)

		return
	}

	c.JSON(http.StatusCreated, registerResponse{
		ClientID:                client.ClientID,
		ClientIDIssuedAt:        client.CreatedAt.Unix(),
		ClientName:              client.Name,
		RedirectURIs:            client.RedirectURIs,
		TokenEndpointAuthMethod: "none",
		GrantTypes:              []string{"authorization_code", "refresh_token"},
		ResponseTypes:           []string{"code"},
	})
}

// Consent hands the browser to the client router, which is where the person is asked.
//
//	@Summary	Start the authorization flow
//	@Tags		mcp
//	@Param		client_id		query	string	true	"registered client"
//	@Param		redirect_uri	query	string	true	"where to return"
//	@Param		code_challenge	query	string	true	"PKCE S256 challenge"
//	@Success	302
//	@Router		/api/v1/oauth/authorize [get]
func (o *OAuth) Consent(c *gin.Context) {
	target := url.URL{Path: consentRoute, RawQuery: c.Request.URL.RawQuery}

	c.Redirect(http.StatusFound, target.String())
}

// ClientInfo describes a registered client for the consent screen.
//
//	@Summary	Describe an OAuth client
//	@Tags		mcp
//	@Produce	json
//	@Param		client_id	query		string	true	"registered client"
//	@Success	200			{object}	clientResponse
//	@Router		/api/v1/oauth/client [get]
func (o *OAuth) ClientInfo(c *gin.Context) {
	client, err := o.service.Client(c.Request.Context(), c.Query("client_id"))
	if err != nil {
		o.oauthError(c, http.StatusNotFound, mcp.ErrInvalidClient)

		return
	}

	c.JSON(http.StatusOK, clientResponse{
		ClientID:     client.ClientID,
		ClientName:   client.Name,
		RedirectURIs: client.RedirectURIs,
	})
}

// Approve records the consent and hands back where to send the browser.
//
//	@Summary	Approve a connector authorization
//	@Tags		mcp
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		request	body		approveRequest	true	"what is being approved"
//	@Success	200		{object}	approveResponse
//	@Failure	403		{object}	response.ErrorResponse
//	@Router		/api/v1/oauth/authorize [post]
func (o *OAuth) Approve(c *gin.Context) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.FailReason(c, http.StatusUnauthorized, response.CodeUnauthorized,
			response.ReasonUnauthenticated, "authentication is required")

		return
	}

	var req approveRequest
	if !request.Bind(c, &req) {
		return
	}

	code, err := o.service.Authorize(c.Request.Context(), userID, req.VaultID,
		req.ClientID, req.RedirectURI, req.CodeChallenge)
	if err != nil {
		o.approvalFailed(c, err)

		return
	}

	redirect, err := url.Parse(req.RedirectURI)
	if err != nil {
		o.oauthError(c, http.StatusBadRequest, mcp.ErrInvalidRequest)

		return
	}

	query := redirect.Query()
	query.Set("code", code)

	if req.State != "" {
		query.Set("state", req.State)
	}

	redirect.RawQuery = query.Encode()

	c.JSON(http.StatusOK, approveResponse{RedirectTo: redirect.String()})
}

// Token exchanges a code or rotates a refresh token.
//
// The body is form-encoded, not JSON: RFC 6749 says so and Claude sends it that way, so a
// JSON-only parser here answers 415 and the connection fails with nothing to read.
//
//	@Summary	Exchange or refresh connector tokens
//	@Tags		mcp
//	@Accept		x-www-form-urlencoded
//	@Produce	json
//	@Success	200	{object}	tokenResponse
//	@Router		/api/v1/oauth/token [post]
func (o *OAuth) Token(c *gin.Context) {
	grantType := c.PostForm("grant_type")
	clientID := c.PostForm("client_id")

	var (
		grant *mcp.Grant
		err   error
	)

	switch grantType {
	case "authorization_code":
		grant, err = o.service.Exchange(c.Request.Context(), clientID,
			c.PostForm("code"), c.PostForm("code_verifier"), c.PostForm("redirect_uri"))
	case "refresh_token":
		grant, err = o.service.Refresh(c.Request.Context(), clientID, c.PostForm("refresh_token"))
	default:
		o.oauthError(c, http.StatusBadRequest, mcp.ErrInvalidRequest)

		return
	}

	if err != nil {
		// 400 with invalid_grant, never a custom code: Claude gives up on anything else and
		// reports the connector as broken rather than as needing to sign in again.
		o.oauthError(c, http.StatusBadRequest, err)

		return
	}

	// No-store, because a proxy holding a copy of this response holds a working credential.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, tokenResponse{
		AccessToken:  grant.AccessToken,
		TokenType:    "Bearer",
		ExpiresIn:    grant.ExpiresIn,
		RefreshToken: grant.RefreshToken,
		Scope:        grant.Scope,
	})
}

func (o *OAuth) approvalFailed(c *gin.Context, err error) {
	switch {
	case errors.Is(err, mcp.ErrOwnerRequired):
		response.FailReason(c, http.StatusForbidden, response.CodeForbidden,
			response.ReasonOwnerRequired, "only the owner of a vault may connect it")
	case errors.Is(err, mcp.ErrNotFound):
		response.FailReason(c, http.StatusNotFound, response.CodeNotFound,
			response.ReasonNotFound, "not found")
	default:
		o.oauthError(c, http.StatusBadRequest, err)
	}
}

// oauthError answers in the shape RFC 6749 defines rather than this API's own envelope: the
// client reading it is an OAuth client, not a Shelf one.
func (o *OAuth) oauthError(c *gin.Context, status int, err error) {
	code := "invalid_request"
	description := err.Error()

	switch {
	case errors.Is(err, mcp.ErrInvalidGrant):
		code = "invalid_grant"
	case errors.Is(err, mcp.ErrInvalidClient):
		code = "invalid_client"
	case errors.Is(err, mcp.ErrInvalidRequest):
		code = "invalid_request"
	default:
		o.log.Warn("oauth request failed", zap.Error(err))
		// The message of an unmapped failure is for this log, not for a stranger.
		description = "the request could not be completed"
	}

	// A sentinel's own text is the code; anything the wrapping added is what actually says
	// what went wrong, and echoing the bare code back helps nobody debug a connection.
	if trimmed := strings.TrimPrefix(description, code+": "); trimmed != description {
		description = trimmed
	} else if description == code {
		description = defaultDescription(code)
	}

	c.Header("Cache-Control", "no-store")
	c.AbortWithStatusJSON(status, gin.H{"error": code, "error_description": description})
}

func defaultDescription(code string) string {
	switch code {
	case "invalid_grant":
		return "that code or refresh token is not usable — start the flow again"
	case "invalid_client":
		return "no client is registered under that client_id"
	default:
		return "the request is missing something it needs"
	}
}
