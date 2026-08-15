package vault

import (
	"time"

	"shelf/internal/vault"
)

// Every binary field travels as base64, the standard []byte encoding of encoding/json.
// The bounds cut off obviously invalid input; nothing here can be validated further,
// because the server cannot read any of it.

type createVaultRequest struct {
	// ClientID is chosen before the row exists, so the metadata can be sealed against a
	// stable identity in one round trip.
	ClientID string `binding:"required,uuid" json:"client_id"`
	// ScopeClientID names the vault's own key scope, which the key below is sealed against.
	ScopeClientID string `binding:"required,uuid"           json:"scope_client_id"`
	Meta          []byte `binding:"required,min=16,max=8192" json:"meta"       format:"byte"`
	MetaNonce     []byte `binding:"required,min=12,max=32"   json:"meta_nonce" format:"byte"`
	// WrappedKey is the vault content key sealed to the creator's own public key.
	WrappedKey []byte `binding:"required,min=32,max=1024" json:"wrapped_key" format:"byte"`
	KeyNonce   []byte `binding:"required,min=12,max=32"   json:"key_nonce"   format:"byte"`
	// Algorithm names the sealed-box format, so a later format can be told apart.
	Algorithm string `binding:"omitempty,max=64" json:"wrap_algorithm,omitempty"`
}

type updateMetaRequest struct {
	Meta      []byte `binding:"required,min=16,max=8192" json:"meta"       format:"byte"`
	MetaNonce []byte `binding:"required,min=12,max=32"   json:"meta_nonce" format:"byte"`
	Position  *int32 `binding:"omitempty,min=0"         json:"position,omitempty"`
}

type createFolderRequest struct {
	ClientID  string `binding:"required,uuid"           json:"client_id"`
	ParentID  *int64 `binding:"omitempty,min=1"         json:"parent_id,omitempty"`
	Meta      []byte `binding:"required,min=16,max=8192" json:"meta"       format:"byte"`
	MetaNonce []byte `binding:"required,min=12,max=32"   json:"meta_nonce" format:"byte"`
	// KeyScopeID and KeyVersion declare which key the blobs were sealed under. The server
	// refuses them when they do not match the destination, because the row would be
	// unreadable to everyone who can see it.
	KeyScopeID int64 `binding:"required,min=1" json:"key_scope_id"`
	KeyVersion int32 `binding:"required,min=1" json:"key_version"`
	Position   int32 `binding:"min=0"          json:"position"`
}

type createFileRequest struct {
	ClientID     string `binding:"required,uuid"              json:"client_id"`
	FolderID     *int64 `binding:"omitempty,min=1"            json:"folder_id,omitempty"`
	Meta         []byte `binding:"required,min=16,max=8192"    json:"meta"          format:"byte"`
	MetaNonce    []byte `binding:"required,min=12,max=32"      json:"meta_nonce"    format:"byte"`
	Content      []byte `binding:"required,min=16,max=4194304" json:"content"       format:"byte"`
	ContentNonce []byte `binding:"required,min=12,max=32"      json:"content_nonce" format:"byte"`
	KeyScopeID   int64  `binding:"required,min=1"              json:"key_scope_id"`
	KeyVersion   int32  `binding:"required,min=1"              json:"key_version"`
}

type updateContentRequest struct {
	Content      []byte `binding:"required,min=16,max=4194304" json:"content"       format:"byte"`
	ContentNonce []byte `binding:"required,min=12,max=32"      json:"content_nonce" format:"byte"`
}

type moveRequest struct {
	ParentID *int64 `binding:"omitempty,min=1" json:"parent_id,omitempty"`
	Position int32  `binding:"min=0"           json:"position"`
}

// bulkFilesRequest hydrates the local search index. The page is bounded so one request
// cannot ask for a whole vault at once.
type bulkFilesRequest struct {
	IDs []int64 `binding:"required,min=1,max=200,dive,min=1" json:"ids"`
}

// VaultResponse is a workspace. Its name and emoji are inside the encrypted meta.
type VaultResponse struct {
	ID        int64     `json:"id"         example:"1"`
	ClientID  string    `json:"client_id"`
	OwnerID   int64     `json:"owner_id"   example:"1"`
	Meta      []byte    `json:"meta"       format:"byte"`
	MetaNonce []byte    `json:"meta_nonce" format:"byte"`
	ChangeSeq int64     `json:"change_seq" example:"42"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// VaultSummaryResponse adds what the vault switcher shows next to the name.
type VaultSummaryResponse struct {
	VaultResponse
	Role        string `json:"role"         example:"owner"`
	KeyState    string `json:"key_state"    example:"ok"`
	KeyScopeID  int64  `json:"key_scope_id" example:"1"`
	KeyVersion  int32  `json:"key_version"  example:"1"`
	NoteCount   int    `json:"note_count"   example:"213"`
	MemberCount int    `json:"member_count" example:"6"`
}

type VaultsResponse struct {
	Vaults []VaultSummaryResponse `json:"vaults"`
}

// KeyGrantResponse is one scope key sealed to the caller. The client opens it with the
// private half of its identity and never sends the result anywhere.
type KeyGrantResponse struct {
	ScopeID       int64  `json:"scope_id"        example:"1"`
	ScopeClientID string `json:"scope_client_id"`
	KeyVersion    int32  `json:"key_version"    example:"1"`
	SubjectType   string `json:"subject_type"   example:"user"`
	SubjectID     int64  `json:"subject_id"     example:"1"`
	WrappedKey    []byte `json:"wrapped_key"    format:"byte"`
	Nonce         []byte `json:"nonce"          format:"byte"`
	Algorithm     string `json:"wrap_algorithm" example:"ecdh-p256-hkdf-a256gcm"`
}

type KeyGrantsResponse struct {
	Grants []KeyGrantResponse `json:"grants"`
}

// ScopeResponse feeds the key status panel.
type ScopeResponse struct {
	ID         int64     `json:"id"          example:"1"`
	ClientID   string    `json:"client_id"`
	ScopeType  string    `json:"scope_type"  example:"vault"`
	RefID      int64     `json:"ref_id"      example:"1"`
	KeyVersion int32     `json:"key_version" example:"4"`
	GrantCount int       `json:"grant_count" example:"6"`
	RotatedAt  time.Time `json:"rotated_at"`
}

type ScopesResponse struct {
	Scopes []ScopeResponse `json:"scopes"`
}

// FolderResponse is a tree node. OwnScope with a grant count of one is what the sidebar
// renders as a solo key.
type FolderResponse struct {
	ID            int64      `json:"id"             example:"12"`
	ClientID      string     `json:"client_id"`
	VaultID       int64      `json:"vault_id"       example:"1"`
	ParentID      *int64     `json:"parent_id"`
	KeyScopeID    int64      `json:"key_scope_id"   example:"1"`
	KeyVersion    int32      `json:"key_version"    example:"1"`
	Meta          []byte     `json:"meta"           format:"byte"`
	MetaNonce     []byte     `json:"meta_nonce"     format:"byte"`
	InheritAccess bool       `json:"inherit_access" example:"true"`
	Depth         int32      `json:"depth"          example:"0"`
	Position      int32      `json:"position"       example:"0"`
	Permission    string     `json:"permission"     example:"own"`
	OwnScope      bool       `json:"own_scope"      example:"false"`
	GrantCount    int        `json:"grant_count"    example:"1"`
	UpdatedSeq    int64      `json:"updated_seq"    example:"41"`
	UpdatedBy     *int64     `json:"updated_by"`
	DeletedAt     *time.Time `json:"deleted_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// FileResponse is a note. Content is only filled by the single read and the bulk
// hydration; the tree deliberately leaves it out.
type FileResponse struct {
	ID            int64      `json:"id"                       example:"88"`
	ClientID      string     `json:"client_id"`
	VaultID       int64      `json:"vault_id"                 example:"1"`
	FolderID      *int64     `json:"folder_id"`
	KeyScopeID    int64      `json:"key_scope_id"             example:"1"`
	KeyVersion    int32      `json:"key_version"              example:"1"`
	Meta          []byte     `json:"meta"                     format:"byte"`
	MetaNonce     []byte     `json:"meta_nonce"               format:"byte"`
	Content       []byte     `json:"content,omitempty"        format:"byte"`
	ContentNonce  []byte     `json:"content_nonce,omitempty"  format:"byte"`
	ContentSeq    int64      `json:"content_seq"              example:"14"`
	ContentSize   int        `json:"content_size"             example:"8192"`
	InheritAccess bool       `json:"inherit_access"           example:"true"`
	Permission    string     `json:"permission"               example:"edit"`
	OwnScope      bool       `json:"own_scope"                example:"false"`
	GrantCount    int        `json:"grant_count"              example:"1"`
	UpdatedSeq    int64      `json:"updated_seq"              example:"42"`
	UpdatedBy     *int64     `json:"updated_by"`
	DeletedAt     *time.Time `json:"deleted_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// TreeResponse is the whole visible tree without any note bodies.
type TreeResponse struct {
	Folders []FolderResponse `json:"folders"`
	Files   []FileResponse   `json:"files"`
}

type FilesResponse struct {
	Files []FileResponse `json:"files"`
}

// ContentResponse acknowledges a body write with the token the next one must carry.
type ContentResponse struct {
	ContentSeq int64     `json:"content_seq" example:"15"`
	UpdatedSeq int64     `json:"updated_seq" example:"43"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func vaultResponse(v *vault.Vault) VaultResponse {
	return VaultResponse{
		ID:        v.ID,
		ClientID:  v.ClientID,
		OwnerID:   v.OwnerID,
		Meta:      v.Meta.Ciphertext,
		MetaNonce: v.Meta.Nonce,
		ChangeSeq: v.ChangeSeq,
		CreatedAt: v.CreatedAt,
		UpdatedAt: v.UpdatedAt,
	}
}

func vaultSummaries(summaries []vault.Summary) VaultsResponse {
	out := make([]VaultSummaryResponse, 0, len(summaries))

	for _, s := range summaries {
		out = append(out, VaultSummaryResponse{
			VaultResponse: vaultResponse(&s.Vault),
			Role:          string(s.Role),
			KeyState:      string(s.KeyState),
			KeyScopeID:    s.KeyScopeID,
			KeyVersion:    s.KeyVersion,
			NoteCount:     s.NoteCount,
			MemberCount:   s.MemberCount,
		})
	}

	return VaultsResponse{Vaults: out}
}

func keyGrants(grants []vault.KeyGrant) KeyGrantsResponse {
	out := make([]KeyGrantResponse, 0, len(grants))

	for _, g := range grants {
		out = append(out, KeyGrantResponse{
			ScopeID:       g.ScopeID,
			ScopeClientID: g.ScopeClientID,
			KeyVersion:    g.KeyVersion,
			SubjectType:   string(g.Subject.Type),
			SubjectID:     g.Subject.ID,
			WrappedKey:    g.WrappedKey,
			Nonce:         g.Nonce,
			Algorithm:     g.Algorithm,
		})
	}

	return KeyGrantsResponse{Grants: out}
}

func scopes(list []vault.ScopeStatus) ScopesResponse {
	out := make([]ScopeResponse, 0, len(list))

	for _, s := range list {
		out = append(out, ScopeResponse{
			ID:         s.ID,
			ClientID:   s.ClientID,
			ScopeType:  string(s.Type),
			RefID:      s.RefID,
			KeyVersion: s.KeyVersion,
			GrantCount: s.GrantCount,
			RotatedAt:  s.RotatedAt,
		})
	}

	return ScopesResponse{Scopes: out}
}

func folderResponse(f *vault.Folder) FolderResponse {
	return FolderResponse{
		ID:            f.ID,
		ClientID:      f.ClientID,
		VaultID:       f.VaultID,
		ParentID:      f.ParentID,
		KeyScopeID:    f.KeyScopeID,
		KeyVersion:    f.KeyVersion,
		Meta:          f.Meta.Ciphertext,
		MetaNonce:     f.Meta.Nonce,
		InheritAccess: f.InheritAccess,
		Depth:         f.Depth,
		Position:      f.Position,
		Permission:    string(f.Access.Permission),
		OwnScope:      f.Access.OwnScope,
		GrantCount:    f.Access.GrantCount,
		UpdatedSeq:    f.UpdatedSeq,
		UpdatedBy:     f.UpdatedBy,
		DeletedAt:     f.DeletedAt,
		CreatedAt:     f.CreatedAt,
		UpdatedAt:     f.UpdatedAt,
	}
}

// fileResponse renders a note; withBody controls whether the ciphertext of the body rides
// along, which is what keeps the tree small.
func fileResponse(f *vault.File, withBody bool) FileResponse {
	out := FileResponse{
		ID:            f.ID,
		ClientID:      f.ClientID,
		VaultID:       f.VaultID,
		FolderID:      f.FolderID,
		KeyScopeID:    f.KeyScopeID,
		KeyVersion:    f.KeyVersion,
		Meta:          f.Meta.Ciphertext,
		MetaNonce:     f.Meta.Nonce,
		ContentSeq:    f.ContentSeq,
		ContentSize:   f.ContentSize,
		InheritAccess: f.InheritAccess,
		Permission:    string(f.Access.Permission),
		OwnScope:      f.Access.OwnScope,
		GrantCount:    f.Access.GrantCount,
		UpdatedSeq:    f.UpdatedSeq,
		UpdatedBy:     f.UpdatedBy,
		DeletedAt:     f.DeletedAt,
		CreatedAt:     f.CreatedAt,
		UpdatedAt:     f.UpdatedAt,
	}

	if withBody {
		out.Content = f.Content.Ciphertext
		out.ContentNonce = f.Content.Nonce
	}

	return out
}

func treeResponse(folders []vault.Folder, files []vault.File) TreeResponse {
	outFolders := make([]FolderResponse, 0, len(folders))
	for i := range folders {
		outFolders = append(outFolders, folderResponse(&folders[i]))
	}

	outFiles := make([]FileResponse, 0, len(files))
	for i := range files {
		outFiles = append(outFiles, fileResponse(&files[i], false))
	}

	return TreeResponse{Folders: outFolders, Files: outFiles}
}

func filesResponse(files []vault.File) FilesResponse {
	out := make([]FileResponse, 0, len(files))
	for i := range files {
		out = append(out, fileResponse(&files[i], true))
	}

	return FilesResponse{Files: out}
}

func blob(ciphertext, nonce []byte) vault.Blob {
	return vault.Blob{Ciphertext: ciphertext, Nonce: nonce}
}
