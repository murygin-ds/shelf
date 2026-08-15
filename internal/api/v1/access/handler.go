// Package access exposes membership, permission grants and invites over HTTP.
package access

import (
	"context"
	"errors"
	"net/http"

	"shelf/internal/access"
	"shelf/internal/api/middleware"
	"shelf/internal/api/request"
	"shelf/internal/api/response"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Service is the slice of the domain this handler needs.
type Service interface {
	Members(ctx context.Context, userID, vaultID int64) ([]access.Member, error)
	Lookup(ctx context.Context, login string) (*access.Directory, error)
	SetRole(ctx context.Context, actorID, vaultID, targetID int64, role vault.Role) error
	RemoveMember(ctx context.Context, actorID, vaultID, targetID int64) ([]int64, error)

	Grants(ctx context.Context, userID, vaultID int64, scopeType vault.ScopeType, scopeRefID int64) ([]access.Grant, error)
	PutGrant(ctx context.Context, actorID int64, in access.GrantInput) (*access.Grant, error)
	DeleteGrant(ctx context.Context, actorID, vaultID, grantID int64) error

	CreateInvite(ctx context.Context, actorID int64, in access.NewInvite) (*access.Invite, error)
	Invites(ctx context.Context, actorID, vaultID int64) ([]access.Invite, error)
	MyInvites(ctx context.Context, userID int64) ([]access.Invite, error)
	RevokeInvite(ctx context.Context, actorID, vaultID, inviteID int64) error
	Challenge(ctx context.Context, tokenHash []byte) (*access.Challenge, error)
	Redeem(ctx context.Context, userID int64, in access.Redemption) (*access.Invite, error)
}

type Handler struct {
	service Service
	// lookupLimit throttles the one endpoint an anonymous caller can use to test a guess.
	lookupLimit middleware.Limiter
	log         *zap.Logger
}

func NewHandler(service Service, lookupLimit middleware.Limiter, log *zap.Logger) *Handler {
	return &Handler{service: service, lookupLimit: lookupLimit, log: log}
}

// RegisterRoutes attaches the access routes. The lookup is mounted on the public group
// because someone redeeming a code may not have an account yet.
func (h *Handler) RegisterRoutes(public, protected *gin.RouterGroup) {
	public.POST("/invites/lookup", middleware.RateLimitByIP(h.lookupLimit), h.LookupInvite)

	vaults := protected.Group("/vaults/:id")
	vaults.GET("/members", h.Members)
	vaults.PATCH("/members/:member_id", h.SetRole)
	vaults.DELETE("/members/:member_id", h.RemoveMember)
	vaults.GET("/grants", h.Grants)
	vaults.PUT("/grants", h.PutGrant)
	vaults.DELETE("/grants/:grant_id", h.DeleteGrant)
	vaults.GET("/invites", h.Invites)
	vaults.POST("/invites", h.CreateInvite)
	vaults.DELETE("/invites/:invite_id", h.RevokeInvite)

	protected.GET("/users/lookup", h.LookupUser)
	protected.GET("/me/invites", h.MyInvites)
	protected.POST("/invites/redeem", h.Redeem)
}

// Members lists the vault's members.
//
//	@Summary	List members
//	@Tags		access
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	MembersResponse
//	@Router		/api/v1/vaults/{id}/members [get]
func (h *Handler) Members(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	list, err := h.service.Members(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "list members", err)
		return
	}

	response.OK(c, members(list))
}

// LookupUser finds an account to seal a key to.
//
//	@Summary	Look up an account
//	@Tags		access
//	@Security	BearerAuth
//	@Produce	json
//	@Param		login	query		string	true	"account login"
//	@Success	200		{object}	DirectoryResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Router		/api/v1/users/lookup [get]
func (h *Handler) LookupUser(c *gin.Context) {
	if _, ok := h.caller(c); !ok {
		return
	}

	login := c.Query("login")
	if len(login) < 3 || len(login) > 64 {
		response.Fail(c, http.StatusNotFound, response.CodeNotFound, "not found")
		return
	}

	found, err := h.service.Lookup(c.Request.Context(), login)
	if err != nil {
		h.fail(c, "look up account", err)
		return
	}

	response.OK(c, directory(found))
}

// SetRole changes a member's role.
//
//	@Summary	Change a member's role
//	@Tags		access
//	@Security	BearerAuth
//	@Accept		json
//	@Param		id			path	int				true	"vault id"
//	@Param		member_id	path	int				true	"member user id"
//	@Param		request		body	setRoleRequest	true	"new role"
//	@Success	204
//	@Failure	403	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/members/{member_id} [patch]
func (h *Handler) SetRole(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	memberID, ok := request.ID(c, "member_id")
	if !ok {
		return
	}

	var req setRoleRequest
	if !request.Bind(c, &req) {
		return
	}

	if err := h.service.SetRole(c.Request.Context(), userID, vaultID, memberID, vault.Role(req.Role)); err != nil {
		h.fail(c, "set role", err)
		return
	}

	response.NoContent(c)
}

// RemoveMember revokes a member's access.
//
//	@Summary	Remove a member
//	@Tags		access
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id			path		int	true	"vault id"
//	@Param		member_id	path		int	true	"member user id"
//	@Success	200			{object}	RemovalResponse
//	@Failure	403			{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/members/{member_id} [delete]
func (h *Handler) RemoveMember(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	memberID, ok := request.ID(c, "member_id")
	if !ok {
		return
	}

	scopes, err := h.service.RemoveMember(c.Request.Context(), userID, vaultID, memberID)
	if err != nil {
		h.fail(c, "remove member", err)
		return
	}

	if scopes == nil {
		scopes = []int64{}
	}

	response.OK(c, RemovalResponse{PendingRotation: scopes})
}

// Grants lists the explicit permissions on one node.
//
//	@Summary	List grants on a node
//	@Tags		access
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id				path		int		true	"vault id"
//	@Param		scope_type		query		string	true	"folder or file"
//	@Param		scope_ref_id	query		int		true	"node id"
//	@Success	200				{object}	GrantsResponse
//	@Router		/api/v1/vaults/{id}/grants [get]
func (h *Handler) Grants(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	kind := c.Query("scope_type")
	if kind != string(vault.ScopeFolder) && kind != string(vault.ScopeFile) {
		response.FailWithDetails(c, http.StatusBadRequest, response.CodeBadRequest,
			"invalid query parameter", map[string]string{"scope_type": "invalid"})

		return
	}

	refID, ok := request.Query(c, "scope_ref_id", 0)
	if !ok {
		return
	}

	if refID <= 0 {
		response.FailWithDetails(c, http.StatusBadRequest, response.CodeBadRequest,
			"invalid query parameter", map[string]string{"scope_ref_id": "invalid"})

		return
	}

	list, err := h.service.Grants(c.Request.Context(), userID, vaultID, scopeType(kind), refID)
	if err != nil {
		h.fail(c, "list grants", err)
		return
	}

	response.OK(c, grants(list))
}

// PutGrant sets one subject's permission on one node.
//
//	@Summary	Grant or narrow access to a node
//	@Tags		access
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int				true	"vault id"
//	@Param		request	body		putGrantRequest	true	"permission and the scope keys sealed to the subject"
//	@Success	200		{object}	GrantResponse
//	@Failure	422		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/grants [put]
func (h *Handler) PutGrant(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req putGrantRequest
	if !request.Bind(c, &req) {
		return
	}

	granted, err := h.service.PutGrant(c.Request.Context(), userID, access.GrantInput{
		VaultID:    vaultID,
		ScopeType:  scopeType(req.ScopeType),
		ScopeRefID: req.ScopeRefID,
		Subject:    vault.Subject{Type: vault.SubjectType(req.SubjectType), ID: req.SubjectID},
		Permission: vault.Permission(req.Permission),
		Keys:       sealedKeys(req.Keys),
	})
	if err != nil {
		h.fail(c, "put grant", err)
		return
	}

	response.OK(c, grantResponse(granted))
}

// DeleteGrant removes an explicit permission, restoring what the node inherits.
//
//	@Summary	Remove a grant
//	@Tags		access
//	@Security	BearerAuth
//	@Param		id			path	int	true	"vault id"
//	@Param		grant_id	path	int	true	"grant id"
//	@Success	204
//	@Router		/api/v1/vaults/{id}/grants/{grant_id} [delete]
func (h *Handler) DeleteGrant(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	grantID, ok := request.ID(c, "grant_id")
	if !ok {
		return
	}

	if err := h.service.DeleteGrant(c.Request.Context(), userID, vaultID, grantID); err != nil {
		h.fail(c, "delete grant", err)
		return
	}

	response.NoContent(c)
}

// CreateInvite opens an admission to the vault.
//
//	@Summary	Create an invite
//	@Tags		access
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"vault id"
//	@Param		request	body		createInviteRequest	true	"invite and the scope keys sealed to it"
//	@Success	201		{object}	InviteResponse
//	@Failure	422		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/invites [post]
func (h *Handler) CreateInvite(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req createInviteRequest
	if !request.Bind(c, &req) {
		return
	}

	// Exactly one path: a code nobody but the holder knows, or an account whose public key
	// the keys were already sealed to.
	if (len(req.TokenHash) == 0) == (req.TargetUserID == nil) {
		response.FailWithDetails(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"request validation failed",
			map[string]string{"token_hash": "exactly one of token_hash and target_user_id"})

		return
	}

	in := access.NewInvite{
		VaultID:    vaultID,
		TokenHash:  req.TokenHash,
		TargetUser: req.TargetUserID,
		EmailHint:  req.EmailHint,
		Role:       vault.Role(req.Role),
		Preview:    vault.Blob{Ciphertext: req.Preview, Nonce: req.PreviewNonce},
		Keys:       sealedKeys(req.Keys),
	}

	if req.ExpiresAt != nil {
		in.ExpiresAt = *req.ExpiresAt
	}

	created, err := h.service.CreateInvite(c.Request.Context(), userID, in)
	if err != nil {
		h.fail(c, "create invite", err)
		return
	}

	response.Created(c, inviteResponse(created))
}

// Invites lists the vault's pending admissions.
//
//	@Summary	List pending invites
//	@Tags		access
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	InvitesResponse
//	@Router		/api/v1/vaults/{id}/invites [get]
func (h *Handler) Invites(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	list, err := h.service.Invites(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "list invites", err)
		return
	}

	response.OK(c, invites(list))
}

// MyInvites lists admissions addressed to the caller.
//
//	@Summary	List my invites
//	@Tags		access
//	@Security	BearerAuth
//	@Produce	json
//	@Success	200	{object}	InvitesResponse
//	@Router		/api/v1/me/invites [get]
func (h *Handler) MyInvites(c *gin.Context) {
	userID, ok := h.caller(c)
	if !ok {
		return
	}

	list, err := h.service.MyInvites(c.Request.Context(), userID)
	if err != nil {
		h.fail(c, "list my invites", err)
		return
	}

	response.OK(c, invites(list))
}

// RevokeInvite closes an admission before it is used.
//
//	@Summary	Revoke an invite
//	@Tags		access
//	@Security	BearerAuth
//	@Param		id			path	int	true	"vault id"
//	@Param		invite_id	path	int	true	"invite id"
//	@Success	204
//	@Router		/api/v1/vaults/{id}/invites/{invite_id} [delete]
func (h *Handler) RevokeInvite(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	inviteID, ok := request.ID(c, "invite_id")
	if !ok {
		return
	}

	if err := h.service.RevokeInvite(c.Request.Context(), userID, vaultID, inviteID); err != nil {
		h.fail(c, "revoke invite", err)
		return
	}

	response.NoContent(c)
}

// LookupInvite resolves a code without requiring an account.
//
// It is a POST rather than a GET so the digest of the code never lands in an access log or
// a browser history, and it is rate limited because it is the one endpoint an anonymous
// caller can use to test a guess.
//
//	@Summary	Resolve an invite code
//	@Tags		access
//	@Accept		json
//	@Produce	json
//	@Param		request	body		lookupInviteRequest	true	"digest of the invite code"
//	@Success	200		{object}	ChallengeResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Failure	429		{object}	response.ErrorResponse
//	@Router		/api/v1/invites/lookup [post]
func (h *Handler) LookupInvite(c *gin.Context) {
	var req lookupInviteRequest
	if !request.Bind(c, &req) {
		return
	}

	found, err := h.service.Challenge(c.Request.Context(), req.TokenHash)
	if err != nil {
		h.fail(c, "look up invite", err)
		return
	}

	// Only failed guesses spend the counter, the same rule the login and recovery
	// endpoints follow: someone holding a valid code is not the threat.
	h.lookupLimit.Refund(c.ClientIP())

	response.OK(c, challenge(found))
}

// Redeem turns an invite into a membership.
//
//	@Summary	Redeem an invite
//	@Tags		access
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		request	body		redeemInviteRequest	true	"the invite and the scope keys re-sealed to the caller"
//	@Success	200		{object}	InviteResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/invites/redeem [post]
func (h *Handler) Redeem(c *gin.Context) {
	userID, ok := h.caller(c)
	if !ok {
		return
	}

	var req redeemInviteRequest
	if !request.Bind(c, &req) {
		return
	}

	if (len(req.TokenHash) == 0) == (req.InviteID == 0) {
		response.FailWithDetails(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"request validation failed",
			map[string]string{"token_hash": "exactly one of token_hash and invite_id"})

		return
	}

	redeemed, err := h.service.Redeem(c.Request.Context(), userID, access.Redemption{
		TokenHash: req.TokenHash,
		InviteID:  req.InviteID,
		Keys:      sealedKeys(req.Keys),
	})
	if err != nil {
		h.fail(c, "redeem invite", err)
		return
	}

	response.OK(c, inviteResponse(redeemed))
}

func (h *Handler) target(c *gin.Context) (userID, vaultID int64, ok bool) {
	userID, ok = h.caller(c)
	if !ok {
		return 0, 0, false
	}

	vaultID, ok = request.ID(c, "id")
	if !ok {
		return 0, 0, false
	}

	return userID, vaultID, true
}

func (h *Handler) caller(c *gin.Context) (int64, bool) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication is required")
		return 0, false
	}

	return userID, true
}

func (h *Handler) fail(c *gin.Context, op string, err error) {
	switch {
	case errors.Is(err, access.ErrNotFound):
		response.Fail(c, http.StatusNotFound, response.CodeNotFound, "not found")
	case errors.Is(err, access.ErrInviteInvalid):
		// Expired, already used, revoked and never existed answer identically: telling
		// them apart would turn the lookup into a probe for valid codes.
		response.Fail(c, http.StatusNotFound, response.CodeNotFound, "not found")
	case errors.Is(err, access.ErrForbidden):
		response.Fail(c, http.StatusForbidden, response.CodeForbidden, "not allowed")
	case errors.Is(err, access.ErrOwnerRequired):
		response.Fail(c, http.StatusForbidden, response.CodeForbidden,
			"the vault owner cannot be changed this way")
	case errors.Is(err, access.ErrSelfTarget):
		response.Fail(c, http.StatusForbidden, response.CodeForbidden,
			"a member cannot apply this to themselves")
	case errors.Is(err, access.ErrAlreadyMember):
		response.Fail(c, http.StatusConflict, response.CodeConflict, "already a member of this vault")
	case errors.Is(err, access.ErrKeysRequired):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"the change needs the scope keys sealed to the subject")
	default:
		middleware.LoggerFrom(c).Error("access handler failed", zap.String("op", op), zap.Error(err))
		response.Internal(c)
	}
}
