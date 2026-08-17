// Package vault exposes the encrypted workspace over HTTP.
package vault

import (
	"context"
	"errors"
	"net/http"

	"shelf/internal/api/middleware"
	"shelf/internal/api/request"
	"shelf/internal/api/response"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Service is the slice of the domain this handler needs.
type Service interface {
	CreateVault(ctx context.Context, ownerID int64, clientID, scopeClientID string, meta vault.Blob, key vault.SealedKey) (*vault.Vault, error)
	Vaults(ctx context.Context, userID int64) ([]vault.Summary, error)
	Vault(ctx context.Context, userID, vaultID int64) (*vault.Vault, error)
	UpdateVault(ctx context.Context, userID, vaultID int64, meta vault.Blob) error
	SetLabel(ctx context.Context, userID, vaultID int64, label *vault.Blob) error
	DeleteVault(ctx context.Context, userID, vaultID int64) error
	Keys(ctx context.Context, userID, vaultID int64) ([]vault.KeyGrant, error)
	Scopes(ctx context.Context, userID, vaultID int64) ([]vault.ScopeStatus, error)
	Tree(ctx context.Context, userID, vaultID int64) ([]vault.Folder, []vault.File, error)
	Sync(ctx context.Context, userID, vaultID, cursor int64, limit int) (*vault.Delta, error)

	StartRekey(ctx context.Context, userID int64, in vault.NewRekey) (*vault.RekeyPlan, error)
	StageRekeyItems(ctx context.Context, userID, rekeyID int64, items []vault.RekeyItem) error
	CommitRekey(ctx context.Context, userID, rekeyID int64, grants []vault.RekeyGrant) (*vault.KeyScope, error)
	AbortRekey(ctx context.Context, userID, rekeyID int64) error

	Audit(ctx context.Context, userID, vaultID, before int64, limit int) ([]vault.AuditEvent, error)

	SetLinks(ctx context.Context, userID, fileID int64, to []int64) error
	Backlinks(ctx context.Context, userID, fileID int64) (*vault.Backlinks, error)
	Graph(ctx context.Context, userID, vaultID int64) (*vault.Graph, error)

	Revisions(ctx context.Context, userID, fileID int64, limit int) ([]vault.Revision, error)
	Revision(ctx context.Context, userID, revisionID int64) (*vault.Revision, error)

	CreateShareLink(ctx context.Context, userID int64, in vault.NewShareLink) (*vault.ShareLink, error)
	ShareLinks(ctx context.Context, userID, fileID int64) ([]vault.ShareLink, error)
	RevokeShareLink(ctx context.Context, userID, linkID int64) error
	PublicNote(ctx context.Context, tokenHash []byte) (*vault.PublicNote, error)
	Trash(ctx context.Context, userID, vaultID int64) ([]vault.Folder, []vault.File, error)

	CreateFolder(ctx context.Context, userID int64, in vault.NewFolder) (*vault.Folder, error)
	UpdateFolder(ctx context.Context, userID, folderID int64, in vault.MetaUpdate) (*vault.Folder, error)
	MoveFolder(ctx context.Context, userID, folderID int64, in vault.Move) (*vault.Folder, error)
	DeleteFolder(ctx context.Context, userID, folderID int64) error
	RestoreFolder(ctx context.Context, userID, folderID int64) error
	PurgeFolder(ctx context.Context, userID, folderID int64) error

	CreateFile(ctx context.Context, userID int64, in vault.NewFile) (*vault.File, error)
	File(ctx context.Context, userID, fileID int64) (*vault.File, error)
	Files(ctx context.Context, userID, vaultID int64, ids []int64) ([]vault.File, error)
	UpdateFile(ctx context.Context, userID, fileID int64, in vault.MetaUpdate) (*vault.File, error)
	UpdateContent(ctx context.Context, userID, fileID int64, in vault.ContentUpdate) (*vault.File, error)
	MoveFile(ctx context.Context, userID, fileID int64, in vault.Move) (*vault.File, error)
	DeleteFile(ctx context.Context, userID, fileID int64) error
	RestoreFile(ctx context.Context, userID, fileID int64) error
	PurgeFile(ctx context.Context, userID, fileID int64) error
}

type Handler struct {
	service Service
	// publicLimit throttles the one route that answers without an account.
	publicLimit middleware.Limiter
	log         *zap.Logger
}

func NewHandler(service Service, publicLimit middleware.Limiter, log *zap.Logger) *Handler {
	return &Handler{service: service, publicLimit: publicLimit, log: log}
}

// RegisterRoutes attaches the workspace routes to an already authenticated group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	vaults := rg.Group("/vaults")
	vaults.POST("", h.CreateVault)
	vaults.GET("", h.Vaults)
	vaults.GET("/:id", h.Vault)
	vaults.PATCH("/:id", h.UpdateVault)
	// Separate from the metadata patch: that one is the shared name and needs manage
	// rights, this one is the caller's own note and every member may write it.
	vaults.PUT("/:id/label", h.SetLabel)
	vaults.DELETE("/:id", h.DeleteVault)
	vaults.GET("/:id/keys", h.Keys)
	vaults.GET("/:id/scopes", h.Scopes)
	vaults.GET("/:id/tree", h.Tree)
	vaults.GET("/:id/sync", h.Sync)
	vaults.GET("/:id/trash", h.Trash)
	vaults.GET("/:id/audit", h.Audit)
	vaults.GET("/:id/graph", h.Graph)
	vaults.POST("/:id/folders", h.CreateFolder)
	vaults.POST("/:id/files", h.CreateFile)
	vaults.POST("/:id/files/bulk", h.BulkFiles)
	vaults.POST("/:id/rekeys", h.StartRekey)

	rekeys := rg.Group("/rekeys")
	rekeys.PUT("/:id/items", h.StageRekey)
	rekeys.POST("/:id/commit", h.CommitRekey)
	rekeys.DELETE("/:id", h.AbortRekey)

	folders := rg.Group("/folders")
	folders.PATCH("/:id", h.UpdateFolder)
	folders.POST("/:id/move", h.MoveFolder)
	folders.DELETE("/:id", h.DeleteFolder)
	folders.POST("/:id/restore", h.RestoreFolder)
	folders.DELETE("/:id/purge", h.PurgeFolder)

	files := rg.Group("/files")
	files.GET("/:id", h.File)
	files.PATCH("/:id", h.UpdateFile)
	files.PUT("/:id/content", h.UpdateContent)
	files.POST("/:id/move", h.MoveFile)
	files.DELETE("/:id", h.DeleteFile)
	files.POST("/:id/restore", h.RestoreFile)
	files.DELETE("/:id/purge", h.PurgeFile)
	files.PUT("/:id/links", h.SetLinks)
	files.GET("/:id/backlinks", h.Backlinks)
	files.GET("/:id/revisions", h.Revisions)
	files.GET("/:id/revisions/:revision_id", h.Revision)
	files.GET("/:id/share-links", h.ShareLinks)
	files.POST("/:id/share-links", h.CreateShareLink)

	rg.DELETE("/share-links/:id", h.RevokeShareLink)
}

// RegisterPublicRoutes attaches the routes that answer without an account.
//
// The link secret travels in the URL fragment and is posted back as a digest, never as a
// path segment: a token in the path lands in every access log and in this service's own
// request logger, which would turn the log file into a set of working keys.
func (h *Handler) RegisterPublicRoutes(rg *gin.RouterGroup) {
	rg.POST("/public/share/lookup", middleware.RateLimitByIP(h.publicLimit), h.PublicNote)
}

// CreateVault opens a vault.
//
//	@Summary	Create a vault
//	@Tags		vaults
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		request	body		createVaultRequest	true	"vault metadata and the content key sealed to the creator"
//	@Success	201		{object}	VaultResponse
//	@Failure	422		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults [post]
func (h *Handler) CreateVault(c *gin.Context) {
	userID, ok := h.caller(c)
	if !ok {
		return
	}

	var req createVaultRequest
	if !request.Bind(c, &req) {
		return
	}

	created, err := h.service.CreateVault(c.Request.Context(), userID, req.ClientID, req.ScopeClientID,
		blob(req.Meta, req.MetaNonce),
		vault.SealedKey{WrappedKey: req.WrappedKey, Nonce: req.KeyNonce, Algorithm: req.Algorithm},
	)
	if err != nil {
		h.fail(c, "create vault", err)
		return
	}

	response.Created(c, vaultResponse(created))
}

// Vaults lists the vaults the caller belongs to.
//
//	@Summary	List vaults
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Success	200	{object}	VaultsResponse
//	@Router		/api/v1/vaults [get]
func (h *Handler) Vaults(c *gin.Context) {
	userID, ok := h.caller(c)
	if !ok {
		return
	}

	summaries, err := h.service.Vaults(c.Request.Context(), userID)
	if err != nil {
		h.fail(c, "list vaults", err)
		return
	}

	response.OK(c, vaultSummaries(summaries))
}

// Vault returns one vault.
//
//	@Summary	Read a vault
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	VaultResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id} [get]
func (h *Handler) Vault(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	found, err := h.service.Vault(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "read vault", err)
		return
	}

	response.OK(c, vaultResponse(found))
}

// UpdateVault renames a vault.
//
//	@Summary	Update vault metadata
//	@Tags		vaults
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path	int					true	"vault id"
//	@Param		request	body	updateMetaRequest	true	"encrypted metadata"
//	@Success	204
//	@Failure	403	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id} [patch]
func (h *Handler) UpdateVault(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req updateMetaRequest
	if !request.Bind(c, &req) {
		return
	}

	if err := h.service.UpdateVault(c.Request.Context(), userID, vaultID, blob(req.Meta, req.MetaNonce)); err != nil {
		h.fail(c, "update vault", err)
		return
	}

	response.NoContent(c)
}

// SetLabel writes the caller's own note on a vault.
//
//	@Summary	Set the caller's private label on a vault
//	@Tags		vaults
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path	int					true	"vault id"
//	@Param		request	body	setLabelRequest		true	"sealed label, empty to clear"
//	@Success	204
//	@Failure	403	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/label [put]
func (h *Handler) SetLabel(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req setLabelRequest
	if !request.Bind(c, &req) {
		return
	}

	// Half a sealed box is bytes nobody can open, so the pair is written or cleared
	// together — an empty body is how a label is removed.
	if (len(req.Label) == 0) != (len(req.LabelNonce) == 0) {
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"a label needs both its ciphertext and its nonce")

		return
	}

	var label *vault.Blob
	if len(req.Label) > 0 {
		label = &vault.Blob{Ciphertext: req.Label, Nonce: req.LabelNonce}
	}

	if err := h.service.SetLabel(c.Request.Context(), userID, vaultID, label); err != nil {
		h.fail(c, "set vault label", err)
		return
	}

	response.NoContent(c)
}

// DeleteVault destroys a vault and everything in it.
//
//	@Summary	Delete a vault
//	@Tags		vaults
//	@Security	BearerAuth
//	@Param		id	path	int	true	"vault id"
//	@Success	204
//	@Failure	403	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id} [delete]
func (h *Handler) DeleteVault(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	if err := h.service.DeleteVault(c.Request.Context(), userID, vaultID); err != nil {
		h.fail(c, "delete vault", err)
		return
	}

	response.NoContent(c)
}

// Keys bootstraps the caller's keyring for one vault.
//
//	@Summary	List the caller's key grants
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	KeyGrantsResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/keys [get]
func (h *Handler) Keys(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	grants, err := h.service.Keys(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "read key grants", err)
		return
	}

	response.OK(c, keyGrants(grants))
}

// Scopes reports the key status of every scope in the vault.
//
//	@Summary	List key scopes
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	ScopesResponse
//	@Router		/api/v1/vaults/{id}/scopes [get]
func (h *Handler) Scopes(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	list, err := h.service.Scopes(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "read key scopes", err)
		return
	}

	response.OK(c, scopes(list))
}

// Tree returns everything in the vault the caller may see, without note bodies.
//
//	@Summary	Read the vault tree
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	TreeResponse
//	@Router		/api/v1/vaults/{id}/tree [get]
func (h *Handler) Tree(c *gin.Context) {
	h.readTree(c, h.service.Tree, "read tree")
}

// Trash returns the soft-deleted nodes the caller may see.
//
//	@Summary	Read the trash
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	TreeResponse
//	@Router		/api/v1/vaults/{id}/trash [get]
func (h *Handler) Trash(c *gin.Context) {
	h.readTree(c, h.service.Trash, "read trash")
}

func (h *Handler) readTree(
	c *gin.Context,
	read func(context.Context, int64, int64) ([]vault.Folder, []vault.File, error),
	op string,
) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	folders, files, err := read(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, op, err)
		return
	}

	response.OK(c, treeResponse(folders, files))
}

// Sync returns the changes a member has not seen yet.
//
//	@Summary	Read the change feed
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id		path		int	true	"vault id"
//	@Param		cursor	query		int	false	"change sequence the client last stored"
//	@Param		limit	query		int	false	"soft page size"
//	@Success	200		{object}	SyncResponse
//	@Router		/api/v1/vaults/{id}/sync [get]
func (h *Handler) Sync(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	cursor, ok := request.Query(c, "cursor", 0)
	if !ok {
		return
	}

	limit, ok := request.Query(c, "limit", vault.DefaultSyncLimit)
	if !ok {
		return
	}

	delta, err := h.service.Sync(c.Request.Context(), userID, vaultID, cursor, int(limit))
	if err != nil {
		h.fail(c, "read changes", err)
		return
	}

	response.OK(c, syncResponse(delta))
}

// Audit reads the access history of a vault.
//
//	@Summary	Read the audit log
//	@Tags		vaults
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id		path		int	true	"vault id"
//	@Param		before	query		int	false	"id of the oldest entry already seen"
//	@Param		limit	query		int	false	"page size"
//	@Success	200		{object}	AuditResponse
//	@Failure	403		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/audit [get]
func (h *Handler) Audit(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	before, ok := request.Query(c, "before", 0)
	if !ok {
		return
	}

	limit, ok := request.Query(c, "limit", vault.DefaultAuditLimit)
	if !ok {
		return
	}

	events, err := h.service.Audit(c.Request.Context(), userID, vaultID, before, int(limit))
	if err != nil {
		h.fail(c, "read audit", err)
		return
	}

	response.OK(c, auditResponse(events))
}

// StartRekey plans a re-encryption: giving a node its own key, or rotating the one it has.
//
//	@Summary	Start a re-key
//	@Tags		keys
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"vault id"
//	@Param		request	body		startRekeyRequest	true	"the node to re-key"
//	@Success	201		{object}	RekeyPlanResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/rekeys [post]
func (h *Handler) StartRekey(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req startRekeyRequest
	if !request.Bind(c, &req) {
		return
	}

	plan, err := h.service.StartRekey(c.Request.Context(), userID, vault.NewRekey{
		VaultID:          vaultID,
		ScopeType:        vault.ScopeType(req.ScopeType),
		ScopeRefID:       req.ScopeRefID,
		NewScopeClientID: req.NewScopeClientID,
	})
	if err != nil {
		h.fail(c, "start rekey", err)
		return
	}

	response.Created(c, rekeyPlan(plan, vault.Fingerprint))
}

// StageRekey accepts a batch of re-encrypted rows.
//
// Staging rather than writing straight through is what lets a large subtree survive the
// write timeout, and what makes a browser that dies mid-way leave staging rows instead of
// a half-encrypted vault.
//
//	@Summary	Stage re-encrypted rows
//	@Tags		keys
//	@Security	BearerAuth
//	@Accept		json
//	@Param		id		path	int					true	"rekey id"
//	@Param		request	body	stageRekeyRequest	true	"re-encrypted rows"
//	@Success	204
//	@Failure	409	{object}	response.ErrorResponse
//	@Router		/api/v1/rekeys/{id}/items [put]
func (h *Handler) StageRekey(c *gin.Context) {
	userID, rekeyID, ok := h.target(c)
	if !ok {
		return
	}

	var req stageRekeyRequest
	if !request.Bind(c, &req) {
		return
	}

	if err := h.service.StageRekeyItems(c.Request.Context(), userID, rekeyID, rekeyItems(req.Items)); err != nil {
		h.fail(c, "stage rekey items", err)
		return
	}

	response.NoContent(c)
}

// CommitRekey applies the job in one transaction.
//
//	@Summary	Commit a re-key
//	@Tags		keys
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"rekey id"
//	@Param		request	body		commitRekeyRequest	true	"the new key sealed to everyone who keeps access"
//	@Success	200		{object}	RekeyResultResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/rekeys/{id}/commit [post]
func (h *Handler) CommitRekey(c *gin.Context) {
	userID, rekeyID, ok := h.target(c)
	if !ok {
		return
	}

	var req commitRekeyRequest
	if !request.Bind(c, &req) {
		return
	}

	scope, err := h.service.CommitRekey(c.Request.Context(), userID, rekeyID, rekeyGrants(req.Keys))
	if err != nil {
		h.fail(c, "commit rekey", err)
		return
	}

	response.OK(c, RekeyResultResponse{
		ScopeID:       scope.ID,
		ScopeClientID: scope.ClientID,
		KeyVersion:    scope.KeyVersion,
	})
}

// AbortRekey drops a job and its staged rows.
//
//	@Summary	Abort a re-key
//	@Tags		keys
//	@Security	BearerAuth
//	@Param		id	path	int	true	"rekey id"
//	@Success	204
//	@Router		/api/v1/rekeys/{id} [delete]
func (h *Handler) AbortRekey(c *gin.Context) {
	userID, rekeyID, ok := h.target(c)
	if !ok {
		return
	}

	if err := h.service.AbortRekey(c.Request.Context(), userID, rekeyID); err != nil {
		h.fail(c, "abort rekey", err)
		return
	}

	response.NoContent(c)
}

// CreateFolder adds a folder to the tree.
//
//	@Summary	Create a folder
//	@Tags		folders
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"vault id"
//	@Param		request	body		createFolderRequest	true	"encrypted folder metadata"
//	@Success	201		{object}	FolderResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/folders [post]
func (h *Handler) CreateFolder(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req createFolderRequest
	if !request.Bind(c, &req) {
		return
	}

	created, err := h.service.CreateFolder(c.Request.Context(), userID, vault.NewFolder{
		ClientID:   req.ClientID,
		VaultID:    vaultID,
		ParentID:   req.ParentID,
		Meta:       blob(req.Meta, req.MetaNonce),
		Position:   req.Position,
		KeyScopeID: req.KeyScopeID,
		KeyVersion: req.KeyVersion,
	})
	if err != nil {
		h.fail(c, "create folder", err)
		return
	}

	response.Created(c, folderResponse(created))
}

// UpdateFolder renames a folder or changes its icon.
//
//	@Summary	Update folder metadata
//	@Tags		folders
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"folder id"
//	@Param		request	body		updateMetaRequest	true	"encrypted folder metadata"
//	@Success	200		{object}	FolderResponse
//	@Router		/api/v1/folders/{id} [patch]
func (h *Handler) UpdateFolder(c *gin.Context) {
	userID, folderID, ok := h.target(c)
	if !ok {
		return
	}

	var req updateMetaRequest
	if !request.Bind(c, &req) {
		return
	}

	updated, err := h.service.UpdateFolder(c.Request.Context(), userID, folderID, vault.MetaUpdate{
		Meta:     blob(req.Meta, req.MetaNonce),
		Position: req.Position,
	})
	if err != nil {
		h.fail(c, "update folder", err)
		return
	}

	response.OK(c, folderResponse(updated))
}

// MoveFolder relocates a folder inside its vault.
//
//	@Summary	Move a folder
//	@Tags		folders
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int			true	"folder id"
//	@Param		request	body		moveRequest	true	"destination"
//	@Success	200		{object}	FolderResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Failure	422		{object}	response.ErrorResponse
//	@Router		/api/v1/folders/{id}/move [post]
func (h *Handler) MoveFolder(c *gin.Context) {
	userID, folderID, ok := h.target(c)
	if !ok {
		return
	}

	var req moveRequest
	if !request.Bind(c, &req) {
		return
	}

	moved, err := h.service.MoveFolder(c.Request.Context(), userID, folderID,
		vault.Move{ParentID: req.ParentID, Position: req.Position})
	if err != nil {
		h.fail(c, "move folder", err)
		return
	}

	response.OK(c, folderResponse(moved))
}

// DeleteFolder moves a folder and its contents to the trash.
//
//	@Summary	Trash a folder
//	@Tags		folders
//	@Security	BearerAuth
//	@Param		id	path	int	true	"folder id"
//	@Success	204
//	@Router		/api/v1/folders/{id} [delete]
func (h *Handler) DeleteFolder(c *gin.Context) {
	h.folderAction(c, h.service.DeleteFolder, "delete folder")
}

// RestoreFolder brings a folder back from the trash.
//
//	@Summary	Restore a folder
//	@Tags		folders
//	@Security	BearerAuth
//	@Param		id	path	int	true	"folder id"
//	@Success	204
//	@Router		/api/v1/folders/{id}/restore [post]
func (h *Handler) RestoreFolder(c *gin.Context) {
	h.folderAction(c, h.service.RestoreFolder, "restore folder")
}

// PurgeFolder destroys a folder and its contents for good.
//
//	@Summary	Purge a folder
//	@Tags		folders
//	@Security	BearerAuth
//	@Param		id	path	int	true	"folder id"
//	@Success	204
//	@Failure	403	{object}	response.ErrorResponse
//	@Router		/api/v1/folders/{id}/purge [delete]
func (h *Handler) PurgeFolder(c *gin.Context) {
	h.folderAction(c, h.service.PurgeFolder, "purge folder")
}

func (h *Handler) folderAction(c *gin.Context, act func(context.Context, int64, int64) error, op string) {
	userID, folderID, ok := h.target(c)
	if !ok {
		return
	}

	if err := act(c.Request.Context(), userID, folderID); err != nil {
		h.fail(c, op, err)
		return
	}

	response.NoContent(c)
}

// CreateFile adds a note.
//
//	@Summary	Create a note
//	@Tags		files
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"vault id"
//	@Param		request	body		createFileRequest	true	"encrypted note"
//	@Success	201		{object}	FileResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/files [post]
func (h *Handler) CreateFile(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req createFileRequest
	if !request.Bind(c, &req) {
		return
	}

	created, err := h.service.CreateFile(c.Request.Context(), userID, vault.NewFile{
		ClientID:   req.ClientID,
		VaultID:    vaultID,
		FolderID:   req.FolderID,
		Meta:       blob(req.Meta, req.MetaNonce),
		Content:    blob(req.Content, req.ContentNonce),
		KeyScopeID: req.KeyScopeID,
		KeyVersion: req.KeyVersion,
	})
	if err != nil {
		h.fail(c, "create file", err)
		return
	}

	response.Created(c, fileResponse(created, true))
}

// File returns one note with its body.
//
//	@Summary	Read a note
//	@Tags		files
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"file id"
//	@Success	200	{object}	FileResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id} [get]
func (h *Handler) File(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	found, err := h.service.File(c.Request.Context(), userID, fileID)
	if err != nil {
		h.fail(c, "read file", err)
		return
	}

	response.OK(c, fileResponse(found, true))
}

// BulkFiles hydrates the local index with note bodies.
//
//	@Summary	Read notes in bulk
//	@Tags		files
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"vault id"
//	@Param		request	body		bulkFilesRequest	true	"note ids, at most 200"
//	@Success	200		{object}	FilesResponse
//	@Router		/api/v1/vaults/{id}/files/bulk [post]
func (h *Handler) BulkFiles(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	var req bulkFilesRequest
	if !request.Bind(c, &req) {
		return
	}

	files, err := h.service.Files(c.Request.Context(), userID, vaultID, req.IDs)
	if err != nil {
		h.fail(c, "read files", err)
		return
	}

	response.OK(c, filesResponse(files))
}

// UpdateFile renames a note or changes its icon.
//
//	@Summary	Update note metadata
//	@Tags		files
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"file id"
//	@Param		request	body		updateMetaRequest	true	"encrypted note metadata"
//	@Success	200		{object}	FileResponse
//	@Router		/api/v1/files/{id} [patch]
func (h *Handler) UpdateFile(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	var req updateMetaRequest
	if !request.Bind(c, &req) {
		return
	}

	updated, err := h.service.UpdateFile(c.Request.Context(), userID, fileID,
		vault.MetaUpdate{Meta: blob(req.Meta, req.MetaNonce)})
	if err != nil {
		h.fail(c, "update file", err)
		return
	}

	response.OK(c, fileResponse(updated, false))
}

// UpdateContent writes a note body under an optimistic lock.
//
//	@Summary	Write a note body
//	@Tags		files
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id			path		int						true	"file id"
//	@Param		If-Match	header		int						true	"content sequence the client last saw"
//	@Param		request		body		updateContentRequest	true	"encrypted body"
//	@Success	200			{object}	ContentResponse
//	@Failure	409			{object}	response.ErrorResponse
//	@Failure	428			{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/content [put]
func (h *Handler) UpdateContent(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	expected, ok := request.IfMatch(c)
	if !ok {
		return
	}

	var req updateContentRequest
	if !request.Bind(c, &req) {
		return
	}

	updated, err := h.service.UpdateContent(c.Request.Context(), userID, fileID, vault.ContentUpdate{
		Content:     blob(req.Content, req.ContentNonce),
		ExpectedSeq: expected,
		KeyScopeID:  req.KeyScopeID,
		KeyVersion:  req.KeyVersion,
		Signature:   req.Signature,
		CRDT:        req.crdtCommit(),
	})
	if err != nil {
		h.fail(c, "update file content", err)
		return
	}

	response.OK(c, ContentResponse{
		ContentSeq: updated.ContentSeq,
		UpdatedSeq: updated.UpdatedSeq,
		UpdatedAt:  updated.UpdatedAt,
	})
}

// MoveFile relocates a note inside its vault.
//
//	@Summary	Move a note
//	@Tags		files
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int			true	"file id"
//	@Param		request	body		moveRequest	true	"destination folder"
//	@Success	200		{object}	FileResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/move [post]
func (h *Handler) MoveFile(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	var req moveRequest
	if !request.Bind(c, &req) {
		return
	}

	moved, err := h.service.MoveFile(c.Request.Context(), userID, fileID,
		vault.Move{ParentID: req.ParentID, Position: req.Position})
	if err != nil {
		h.fail(c, "move file", err)
		return
	}

	response.OK(c, fileResponse(moved, false))
}

// DeleteFile moves a note to the trash.
//
//	@Summary	Trash a note
//	@Tags		files
//	@Security	BearerAuth
//	@Param		id	path	int	true	"file id"
//	@Success	204
//	@Router		/api/v1/files/{id} [delete]
func (h *Handler) DeleteFile(c *gin.Context) {
	h.folderAction(c, h.service.DeleteFile, "delete file")
}

// RestoreFile brings a note back from the trash.
//
//	@Summary	Restore a note
//	@Tags		files
//	@Security	BearerAuth
//	@Param		id	path	int	true	"file id"
//	@Success	204
//	@Router		/api/v1/files/{id}/restore [post]
func (h *Handler) RestoreFile(c *gin.Context) {
	h.folderAction(c, h.service.RestoreFile, "restore file")
}

// PurgeFile destroys a note for good.
//
//	@Summary	Purge a note
//	@Tags		files
//	@Security	BearerAuth
//	@Param		id	path	int	true	"file id"
//	@Success	204
//	@Failure	403	{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/purge [delete]
func (h *Handler) PurgeFile(c *gin.Context) {
	h.folderAction(c, h.service.PurgeFile, "purge file")
}

// target reads the caller and the id every route in this handler takes first.
func (h *Handler) target(c *gin.Context) (userID, id int64, ok bool) {
	userID, ok = h.caller(c)
	if !ok {
		return 0, 0, false
	}

	id, ok = request.ID(c, "id")
	if !ok {
		return 0, 0, false
	}

	return userID, id, true
}

// caller reads the authenticated user. Every route here sits behind the auth middleware,
// so a missing id means the route was mounted outside it — answered rather than ignored,
// because an empty 200 would be the hardest possible version of that bug to find.
func (h *Handler) caller(c *gin.Context) (int64, bool) {
	userID, ok := middleware.UserIDFrom(c)
	if !ok {
		response.Fail(c, http.StatusUnauthorized, response.CodeUnauthorized, "authentication is required")
		return 0, false
	}

	return userID, true
}

// fail maps the domain errors onto the response format. Anything unmapped is a bug, so it
// is logged in full and answered without detail.
func (h *Handler) fail(c *gin.Context, op string, err error) {
	switch {
	case errors.Is(err, vault.ErrNotFound):
		response.Fail(c, http.StatusNotFound, response.CodeNotFound, "not found")
	case errors.Is(err, vault.ErrForbidden):
		response.Fail(c, http.StatusForbidden, response.CodeForbidden, "not allowed")
	case errors.Is(err, vault.ErrVersionConflict):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"the note was changed by someone else")
	case errors.Is(err, vault.ErrScopeMismatch):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"the payload was encrypted for a different key scope")
	case errors.Is(err, vault.ErrCycle):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"a folder cannot be moved into itself")
	case errors.Is(err, vault.ErrDepthExceeded):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"the folder tree would become too deep")
	case errors.Is(err, vault.ErrShareExpiry):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"a public link must expire in the future")
	case errors.Is(err, vault.ErrLinkBatch):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"a note may declare at most 500 outgoing links")
	case errors.Is(err, vault.ErrSignatureInvalid):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"an author signature must be 64 raw bytes")
	case errors.Is(err, vault.ErrRekeyStale):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"this re-key is no longer open")
	case errors.Is(err, vault.ErrKeyGrantMissing):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"the new key must be sealed to at least one subject")
	case errors.Is(err, vault.ErrRekeyBatch):
		response.Fail(c, http.StatusUnprocessableEntity, response.CodeValidation,
			"a staging batch must hold between 1 and 200 rows")
	case errors.Is(err, vault.ErrEpochMismatch):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"this editing session has been replaced")
	case errors.Is(err, vault.ErrCompactRequired):
		response.Fail(c, http.StatusConflict, response.CodeConflict,
			"the editing session needs to be committed before it can take more changes")
	case errors.Is(err, vault.ErrUpdateTooLarge):
		response.Fail(c, http.StatusRequestEntityTooLarge, response.CodeTooLarge,
			"the editing session state is too large")
	default:
		middleware.LoggerFrom(c).Error("vault handler failed", zap.String("op", op), zap.Error(err))
		response.Internal(c)
	}
}

// SetLinks records what a note points at.
//
//	@Summary	Replace a note's outgoing links
//	@Tags		graph
//	@Security	BearerAuth
//	@Accept		json
//	@Param		id		path	int				true	"file id"
//	@Param		request	body	setLinksRequest	true	"resolved targets"
//	@Success	204
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/links [put]
func (h *Handler) SetLinks(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	var req setLinksRequest
	if !request.Bind(c, &req) {
		return
	}

	if err := h.service.SetLinks(c.Request.Context(), userID, fileID, req.To); err != nil {
		h.fail(c, "set links", err)
		return
	}

	response.NoContent(c)
}

// Backlinks lists what points at a note, and counts what points at it out of sight.
//
//	@Summary	List backlinks
//	@Tags		graph
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"file id"
//	@Success	200	{object}	BacklinksResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/backlinks [get]
func (h *Handler) Backlinks(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	found, err := h.service.Backlinks(c.Request.Context(), userID, fileID)
	if err != nil {
		h.fail(c, "read backlinks", err)
		return
	}

	response.OK(c, backlinksResponse(found))
}

// Graph draws the vault's link structure as this caller sees it.
//
//	@Summary	Read the note graph
//	@Tags		graph
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"vault id"
//	@Success	200	{object}	GraphResponse
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/vaults/{id}/graph [get]
func (h *Handler) Graph(c *gin.Context) {
	userID, vaultID, ok := h.target(c)
	if !ok {
		return
	}

	graph, err := h.service.Graph(c.Request.Context(), userID, vaultID)
	if err != nil {
		h.fail(c, "read graph", err)
		return
	}

	response.OK(c, graphResponse(graph))
}

// Revisions lists the history of a note without the bodies.
//
//	@Summary	List revisions
//	@Tags		revisions
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id		path		int	true	"file id"
//	@Param		limit	query		int	false	"page size"
//	@Success	200		{object}	RevisionsResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/revisions [get]
func (h *Handler) Revisions(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	limit, ok := request.Query(c, "limit", vault.DefaultRevisionLimit)
	if !ok {
		return
	}

	list, err := h.service.Revisions(c.Request.Context(), userID, fileID, int(limit))
	if err != nil {
		h.fail(c, "read revisions", err)
		return
	}

	response.OK(c, revisionsResponse(list))
}

// Revision reads one stored body.
//
//	@Summary	Read a revision
//	@Tags		revisions
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id			path		int	true	"file id"
//	@Param		revision_id	path		int	true	"revision id"
//	@Success	200			{object}	RevisionResponse
//	@Failure	404			{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/revisions/{revision_id} [get]
func (h *Handler) Revision(c *gin.Context) {
	userID, ok := h.caller(c)
	if !ok {
		return
	}

	revisionID, ok := request.ID(c, "revision_id")
	if !ok {
		return
	}

	found, err := h.service.Revision(c.Request.Context(), userID, revisionID)
	if err != nil {
		h.fail(c, "read revision", err)
		return
	}

	response.OK(c, revisionResponse(found, true))
}

// CreateShareLink publishes a note behind a secret the server never sees.
//
//	@Summary	Open a public link
//	@Tags		sharing
//	@Security	BearerAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int					true	"file id"
//	@Param		request	body		createShareRequest	true	"the note key wrapped under the link secret"
//	@Success	201		{object}	ShareLinkResponse
//	@Failure	409		{object}	response.ErrorResponse
//	@Router		/api/v1/files/{id}/share-links [post]
func (h *Handler) CreateShareLink(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	var req createShareRequest
	if !request.Bind(c, &req) {
		return
	}

	created, err := h.service.CreateShareLink(c.Request.Context(), userID, vault.NewShareLink{
		FileID:     fileID,
		TokenHash:  req.TokenHash,
		Meta:       blob(req.Meta, req.MetaNonce),
		Content:    blob(req.Content, req.ContentNonce),
		ContentSeq: req.ContentSeq,
		ExpiresAt:  req.ExpiresAt,
	})
	if err != nil {
		h.fail(c, "create share link", err)
		return
	}

	response.Created(c, shareLinkResponse(created))
}

// ShareLinks lists the public links on a note.
//
//	@Summary	List public links
//	@Tags		sharing
//	@Security	BearerAuth
//	@Produce	json
//	@Param		id	path		int	true	"file id"
//	@Success	200	{object}	ShareLinksResponse
//	@Router		/api/v1/files/{id}/share-links [get]
func (h *Handler) ShareLinks(c *gin.Context) {
	userID, fileID, ok := h.target(c)
	if !ok {
		return
	}

	links, err := h.service.ShareLinks(c.Request.Context(), userID, fileID)
	if err != nil {
		h.fail(c, "list share links", err)
		return
	}

	response.OK(c, shareLinksResponse(links))
}

// RevokeShareLink closes a public link.
//
//	@Summary	Revoke a public link
//	@Tags		sharing
//	@Security	BearerAuth
//	@Param		id	path	int	true	"share link id"
//	@Success	204
//	@Failure	404	{object}	response.ErrorResponse
//	@Router		/api/v1/share-links/{id} [delete]
func (h *Handler) RevokeShareLink(c *gin.Context) {
	userID, linkID, ok := h.target(c)
	if !ok {
		return
	}

	if err := h.service.RevokeShareLink(c.Request.Context(), userID, linkID); err != nil {
		h.fail(c, "revoke share link", err)
		return
	}

	response.NoContent(c)
}

// PublicNote resolves a public link with no account behind it.
//
//	@Summary	Open a shared note
//	@Tags		sharing
//	@Accept		json
//	@Produce	json
//	@Param		request	body		lookupShareRequest	true	"digest of the link secret"
//	@Success	200		{object}	PublicNoteResponse
//	@Failure	404		{object}	response.ErrorResponse
//	@Failure	429		{object}	response.ErrorResponse
//	@Router		/api/v1/public/share/lookup [post]
func (h *Handler) PublicNote(c *gin.Context) {
	var req lookupShareRequest
	if !request.Bind(c, &req) {
		return
	}

	note, err := h.service.PublicNote(c.Request.Context(), req.TokenHash)
	if err != nil {
		h.fail(c, "resolve share link", err)
		return
	}

	// Only failed guesses spend the counter, the rule the login, recovery and invite
	// endpoints already follow: somebody holding a working link is not the threat.
	h.publicLimit.Refund(c.ClientIP())

	response.OK(c, publicNoteResponse(note))
}
