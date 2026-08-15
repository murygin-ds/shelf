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
	DeleteVault(ctx context.Context, userID, vaultID int64) error
	Keys(ctx context.Context, userID, vaultID int64) ([]vault.KeyGrant, error)
	Scopes(ctx context.Context, userID, vaultID int64) ([]vault.ScopeStatus, error)
	Tree(ctx context.Context, userID, vaultID int64) ([]vault.Folder, []vault.File, error)
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
	log     *zap.Logger
}

func NewHandler(service Service, log *zap.Logger) *Handler {
	return &Handler{service: service, log: log}
}

// RegisterRoutes attaches the workspace routes to an already authenticated group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	vaults := rg.Group("/vaults")
	vaults.POST("", h.CreateVault)
	vaults.GET("", h.Vaults)
	vaults.GET("/:id", h.Vault)
	vaults.PATCH("/:id", h.UpdateVault)
	vaults.DELETE("/:id", h.DeleteVault)
	vaults.GET("/:id/keys", h.Keys)
	vaults.GET("/:id/scopes", h.Scopes)
	vaults.GET("/:id/tree", h.Tree)
	vaults.GET("/:id/trash", h.Trash)
	vaults.POST("/:id/folders", h.CreateFolder)
	vaults.POST("/:id/files", h.CreateFile)
	vaults.POST("/:id/files/bulk", h.BulkFiles)

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
	default:
		middleware.LoggerFrom(c).Error("vault handler failed", zap.String("op", op), zap.Error(err))
		response.Internal(c)
	}
}
