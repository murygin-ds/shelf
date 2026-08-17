package vault

import (
	"encoding/json"
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

// setLabelRequest carries a note sealed to the caller's own identity key. Both fields
// empty clears the label; the server never sees either as anything but bytes.
type setLabelRequest struct {
	Label      []byte `binding:"omitempty,max=1024" json:"label"       format:"byte"`
	LabelNonce []byte `binding:"omitempty,max=32"   json:"label_nonce" format:"byte"`
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
	// The scope and version the body was sealed under. content_seq alone does not cover
	// them: a re-key rewrites the row without touching that sequence, so a write held up
	// across a rotation would otherwise land ciphertext under a key nobody holds and the
	// row would claim the new version.
	KeyScopeID int64 `binding:"required,min=1" json:"key_scope_id"`
	KeyVersion int32 `binding:"required,min=1" json:"key_version"`
	// Signature is the author's raw ECDSA P-256 signature over this exact ciphertext in
	// this exact slot. Optional so an older client still writes, but a body without one is
	// stored as unsigned and the history says so rather than implying authorship.
	Signature []byte `binding:"omitempty,len=64" json:"signature,omitempty" format:"byte"`
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
	Role     string `json:"role"      example:"owner"`
	KeyState string `json:"key_state" example:"ok"`
	// KeyScopeClientID is what a sealed key names. Sealing against the vault's own client
	// id instead produces a key that silently refuses to open.
	KeyScopeClientID string `json:"key_scope_client_id"`
	KeyScopeID       int64  `json:"key_scope_id" example:"1"`
	KeyVersion       int32  `json:"key_version"  example:"1"`
	NoteCount        int    `json:"note_count"   example:"213"`
	MemberCount      int    `json:"member_count" example:"6"`
	// Label is the caller's own note on this vault, sealed to their identity key. Absent
	// when they have not written one; no other member ever receives it.
	Label      []byte `json:"label,omitempty"       format:"byte"`
	LabelNonce []byte `json:"label_nonce,omitempty" format:"byte"`
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
	ID               int64      `json:"id"             example:"12"`
	ClientID         string     `json:"client_id"`
	VaultID          int64      `json:"vault_id"       example:"1"`
	ParentID         *int64     `json:"parent_id"`
	KeyScopeClientID string     `json:"key_scope_client_id"`
	KeyScopeID       int64      `json:"key_scope_id"   example:"1"`
	KeyVersion       int32      `json:"key_version"    example:"1"`
	Meta             []byte     `json:"meta"           format:"byte"`
	MetaNonce        []byte     `json:"meta_nonce"     format:"byte"`
	InheritAccess    bool       `json:"inherit_access" example:"true"`
	Depth            int32      `json:"depth"          example:"0"`
	Position         int32      `json:"position"       example:"0"`
	Permission       string     `json:"permission"     example:"own"`
	OwnScope         bool       `json:"own_scope"      example:"false"`
	GrantCount       int        `json:"grant_count"    example:"1"`
	UpdatedSeq       int64      `json:"updated_seq"    example:"41"`
	UpdatedBy        *int64     `json:"updated_by"`
	DeletedAt        *time.Time `json:"deleted_at"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

// FileResponse is a note. Content is only filled by the single read and the bulk
// hydration; the tree deliberately leaves it out.
type FileResponse struct {
	ID               int64      `json:"id"                       example:"88"`
	ClientID         string     `json:"client_id"`
	VaultID          int64      `json:"vault_id"                 example:"1"`
	FolderID         *int64     `json:"folder_id"`
	KeyScopeClientID string     `json:"key_scope_client_id"`
	KeyScopeID       int64      `json:"key_scope_id"             example:"1"`
	KeyVersion       int32      `json:"key_version"              example:"1"`
	Meta             []byte     `json:"meta"                     format:"byte"`
	MetaNonce        []byte     `json:"meta_nonce"               format:"byte"`
	Content          []byte     `json:"content,omitempty"        format:"byte"`
	ContentNonce     []byte     `json:"content_nonce,omitempty"  format:"byte"`
	ContentSeq       int64      `json:"content_seq"              example:"14"`
	ContentSize      int        `json:"content_size"             example:"8192"`
	InheritAccess    bool       `json:"inherit_access"           example:"true"`
	Permission       string     `json:"permission"               example:"edit"`
	OwnScope         bool       `json:"own_scope"                example:"false"`
	GrantCount       int        `json:"grant_count"              example:"1"`
	UpdatedSeq       int64      `json:"updated_seq"              example:"42"`
	UpdatedBy        *int64     `json:"updated_by"`
	DeletedAt        *time.Time `json:"deleted_at"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

// TreeResponse is the whole visible tree without any note bodies.
type TreeResponse struct {
	Folders []FolderResponse `json:"folders"`
	Files   []FileResponse   `json:"files"`
}

type FilesResponse struct {
	Files []FileResponse `json:"files"`
}

// PurgedResponse lists the nodes that were destroyed outright. A trashed node needs no
// entry: it travels as an ordinary update carrying a deletion timestamp.
type PurgedResponse struct {
	Folders []int64 `json:"folders"`
	Files   []int64 `json:"files"`
}

// SyncResponse is one page of changes. The cursor is a change sequence, not a timestamp:
// two rows written in one transaction share a clock reading, and a reader that interleaved
// between them would drop one of them for good.
type SyncResponse struct {
	Cursor  int64 `json:"cursor"   example:"4821"`
	HasMore bool  `json:"has_more" example:"false"`
	// FullResync tells the client to drop its cached copy of this vault. It is the only
	// way it learns to forget plaintext it cached before losing access to it.
	FullResync bool             `json:"full_resync_required" example:"false"`
	Folders    []FolderResponse `json:"folders"`
	Files      []FileResponse   `json:"files"`
	Purged     PurgedResponse   `json:"purged"`
}

func syncResponse(delta *vault.Delta) SyncResponse {
	folders := make([]FolderResponse, 0, len(delta.Folders))
	for i := range delta.Folders {
		folders = append(folders, folderResponse(&delta.Folders[i]))
	}

	files := make([]FileResponse, 0, len(delta.Files))
	for i := range delta.Files {
		files = append(files, fileResponse(&delta.Files[i], false))
	}

	return SyncResponse{
		Cursor:     delta.Cursor,
		HasMore:    delta.HasMore,
		FullResync: delta.FullResync,
		Folders:    folders,
		Files:      files,
		// Empty rather than null: the client iterates these on every poll, and a null
		// would make an ordinary quiet page look like a malformed one.
		Purged: PurgedResponse{
			Folders: ids(delta.Purged.Folders),
			Files:   ids(delta.Purged.Files),
		},
	}
}

func ids(values []int64) []int64 {
	if values == nil {
		return []int64{}
	}

	return values
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
		summary := VaultSummaryResponse{
			VaultResponse:    vaultResponse(&s.Vault),
			Role:             string(s.Role),
			KeyState:         string(s.KeyState),
			KeyScopeClientID: s.KeyScopeClientID,
			KeyScopeID:       s.KeyScopeID,
			KeyVersion:       s.KeyVersion,
			NoteCount:        s.NoteCount,
			MemberCount:      s.MemberCount,
		}

		if s.Label != nil {
			summary.Label = s.Label.Ciphertext
			summary.LabelNonce = s.Label.Nonce
		}

		out = append(out, summary)
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
		ID:               f.ID,
		ClientID:         f.ClientID,
		VaultID:          f.VaultID,
		ParentID:         f.ParentID,
		KeyScopeClientID: f.KeyScopeClientID,
		KeyScopeID:       f.KeyScopeID,
		KeyVersion:       f.KeyVersion,
		Meta:             f.Meta.Ciphertext,
		MetaNonce:        f.Meta.Nonce,
		InheritAccess:    f.InheritAccess,
		Depth:            f.Depth,
		Position:         f.Position,
		Permission:       string(f.Access.Permission),
		OwnScope:         f.Access.OwnScope,
		GrantCount:       f.Access.GrantCount,
		UpdatedSeq:       f.UpdatedSeq,
		UpdatedBy:        f.UpdatedBy,
		DeletedAt:        f.DeletedAt,
		CreatedAt:        f.CreatedAt,
		UpdatedAt:        f.UpdatedAt,
	}
}

// fileResponse renders a note; withBody controls whether the ciphertext of the body rides
// along, which is what keeps the tree small.
func fileResponse(f *vault.File, withBody bool) FileResponse {
	out := FileResponse{
		ID:               f.ID,
		ClientID:         f.ClientID,
		VaultID:          f.VaultID,
		FolderID:         f.FolderID,
		KeyScopeClientID: f.KeyScopeClientID,
		KeyScopeID:       f.KeyScopeID,
		KeyVersion:       f.KeyVersion,
		Meta:             f.Meta.Ciphertext,
		MetaNonce:        f.Meta.Nonce,
		ContentSeq:       f.ContentSeq,
		ContentSize:      f.ContentSize,
		InheritAccess:    f.InheritAccess,
		Permission:       string(f.Access.Permission),
		OwnScope:         f.Access.OwnScope,
		GrantCount:       f.Access.GrantCount,
		UpdatedSeq:       f.UpdatedSeq,
		UpdatedBy:        f.UpdatedBy,
		DeletedAt:        f.DeletedAt,
		CreatedAt:        f.CreatedAt,
		UpdatedAt:        f.UpdatedAt,
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

type startRekeyRequest struct {
	ScopeType  string `binding:"required,oneof=vault folder file" json:"scope_type"`
	ScopeRefID int64  `binding:"required,min=1"                   json:"scope_ref_id"`
	// NewScopeClientID names the scope the new key belongs to. It is required when the job
	// creates a scope, because the sealed keys have to name it before the row exists.
	NewScopeClientID string `binding:"omitempty,uuid" json:"new_scope_client_id,omitempty"`
}

type rekeyItemRequest struct {
	EntityType   string `binding:"required,oneof=vault folder file" json:"entity_type"`
	EntityID     int64  `binding:"required,min=1"                json:"entity_id"`
	Meta         []byte `binding:"required,min=16,max=8192"      json:"meta"          format:"byte"`
	MetaNonce    []byte `binding:"required,min=12,max=32"        json:"meta_nonce"    format:"byte"`
	Content      []byte `binding:"omitempty,min=16,max=4194304"  json:"content,omitempty"       format:"byte"`
	ContentNonce []byte `binding:"omitempty,min=12,max=32"       json:"content_nonce,omitempty" format:"byte"`
}

type stageRekeyRequest struct {
	Items []rekeyItemRequest `binding:"required,min=1,max=200,dive" json:"items"`
}

type rekeyGrantRequest struct {
	SubjectType string `binding:"required,oneof=user group"  json:"subject_type"`
	SubjectID   int64  `binding:"required,min=1"             json:"subject_id"`
	WrappedKey  []byte `binding:"required,min=32,max=2048"   json:"wrapped_key" format:"byte"`
	Nonce       []byte `binding:"required,min=12,max=32"     json:"nonce"       format:"byte"`
	Algorithm   string `binding:"omitempty,max=64"           json:"wrap_algorithm,omitempty"`
}

type commitRekeyRequest struct {
	Keys []rekeyGrantRequest `binding:"required,min=1,max=256,dive" json:"key_grants"`
}

// RekeySubjectResponse is somebody the new key has to be sealed to, with the fingerprint
// to check the public key really is theirs.
// RekeySubjectResponse is a person or a group that keeps the key. A group is sealed to
// once, whatever its membership, which is the whole reason groups have keys of their own.
type RekeySubjectResponse struct {
	UserID        int64  `json:"user_id,omitempty"      example:"7"`
	Login         string `json:"login,omitempty"        example:"marta@acme.dev"`
	DisplayName   string `json:"display_name,omitempty" example:"Marta Chen"`
	GroupID       int64  `json:"group_id,omitempty"     example:"3"`
	GroupClientID string `json:"group_client_id,omitempty"`
	PublicKey     []byte `json:"public_key"             format:"byte"`
	Fingerprint   string `json:"fingerprint,omitempty"  example:"A1B2 C3D4 E5F6 G7H8"`
}

// RekeyPlanResponse is everything a client needs to carry out a re-key: the rows to
// re-encrypt and whose keys the new one must reach.
type RekeyPlanResponse struct {
	ID            int64                  `json:"id"                example:"3"`
	ScopeType     string                 `json:"scope_type"        example:"folder"`
	ScopeRefID    int64                  `json:"scope_ref_id"      example:"12"`
	ScopeClientID string                 `json:"scope_client_id"`
	CreatesScope  bool                   `json:"creates_scope"     example:"true"`
	CoversVault   bool                   `json:"covers_vault"      example:"false"`
	FromVersion   int32                  `json:"from_version"      example:"0"`
	ToVersion     int32                  `json:"to_version"        example:"1"`
	Folders       []int64                `json:"folders"`
	Files         []int64                `json:"files"`
	Subjects      []RekeySubjectResponse `json:"subjects"`
	ExpiresAt     time.Time              `json:"expires_at"`
}

// RekeyResultResponse is the scope as it stands after the commit.
type RekeyResultResponse struct {
	ScopeID       int64  `json:"scope_id"        example:"4"`
	ScopeClientID string `json:"scope_client_id"`
	KeyVersion    int32  `json:"key_version"     example:"1"`
}

func rekeyPlan(plan *vault.RekeyPlan, fingerprint func([]byte) string) RekeyPlanResponse {
	subjects := make([]RekeySubjectResponse, 0, len(plan.Subjects))

	for _, subject := range plan.Subjects {
		converted := RekeySubjectResponse{
			UserID:        subject.UserID,
			Login:         subject.Login,
			DisplayName:   subject.DisplayName,
			GroupID:       subject.GroupID,
			GroupClientID: subject.GroupClientID,
			PublicKey:     subject.PublicKey,
		}

		// A group has no fingerprint to compare out of band: nobody holds its key alone,
		// so there is no second party to compare it with.
		if !subject.IsGroup() {
			converted.Fingerprint = fingerprint(subject.PublicKey)
		}

		subjects = append(subjects, converted)
	}

	return RekeyPlanResponse{
		ID:            plan.ID,
		ScopeType:     string(plan.ScopeType),
		ScopeRefID:    plan.ScopeRefID,
		ScopeClientID: plan.ScopeClientID,
		CreatesScope:  plan.Creates,
		CoversVault:   plan.Vault,
		FromVersion:   plan.FromVersion,
		ToVersion:     plan.ToVersion,
		Folders:       ids(plan.Folders),
		Files:         ids(plan.Files),
		Subjects:      subjects,
		ExpiresAt:     plan.ExpiresAt,
	}
}

func rekeyItems(in []rekeyItemRequest) []vault.RekeyItem {
	out := make([]vault.RekeyItem, 0, len(in))

	for _, item := range in {
		converted := vault.RekeyItem{
			EntityType: vault.ScopeType(item.EntityType),
			EntityID:   item.EntityID,
			Meta:       blob(item.Meta, item.MetaNonce),
		}

		if len(item.Content) > 0 {
			body := blob(item.Content, item.ContentNonce)
			converted.Content = &body
		}

		out = append(out, converted)
	}

	return out
}

func rekeyGrants(in []rekeyGrantRequest) []vault.RekeyGrant {
	out := make([]vault.RekeyGrant, 0, len(in))

	for _, grant := range in {
		out = append(out, vault.RekeyGrant{
			Subject:    vault.Subject{Type: vault.SubjectType(grant.SubjectType), ID: grant.SubjectID},
			WrappedKey: grant.WrappedKey,
			Nonce:      grant.Nonce,
			Algorithm:  grant.Algorithm,
		})
	}

	return out
}

// AuditEventResponse is one entry of the access history. It names nodes and people by id:
// the reader renders them from their own decrypted tree, and an entry about a node they
// cannot see stays an id, which is the truthful thing to show.
type AuditEventResponse struct {
	ID          int64           `json:"id"                     example:"91"`
	ActorID     *int64          `json:"actor_id,omitempty"`
	ActorLogin  string          `json:"actor_login,omitempty"  example:"marta@acme.dev"`
	ActorName   string          `json:"actor_name,omitempty"   example:"Marta Chen"`
	Action      string          `json:"action"                 example:"key.rotated"`
	TargetType  string          `json:"target_type,omitempty"  example:"folder"`
	TargetID    *int64          `json:"target_id,omitempty"`
	SubjectType string          `json:"subject_type,omitempty" example:"user"`
	SubjectID   *int64          `json:"subject_id,omitempty"`
	Detail      json.RawMessage `json:"detail"                 swaggertype:"object"`
	CreatedAt   time.Time       `json:"created_at"`
}

type AuditResponse struct {
	Events []AuditEventResponse `json:"events"`
	// Cursor is the id to pass as before= for the next page; zero when the log is exhausted.
	Cursor int64 `json:"cursor" example:"91"`
}

func auditResponse(events []vault.AuditEvent) AuditResponse {
	out := AuditResponse{Events: make([]AuditEventResponse, 0, len(events))}

	for _, e := range events {
		out.Events = append(out.Events, AuditEventResponse{
			ID:          e.ID,
			ActorID:     e.ActorID,
			ActorLogin:  e.ActorLogin,
			ActorName:   e.ActorName,
			Action:      string(e.Action),
			TargetType:  e.TargetType,
			TargetID:    e.TargetID,
			SubjectType: e.SubjectType,
			SubjectID:   e.SubjectID,
			Detail:      e.Detail,
			CreatedAt:   e.CreatedAt,
		})
	}

	if n := len(events); n > 0 {
		out.Cursor = events[n-1].ID
	}

	return out
}

// -- graph -------------------------------------------------------------------

type setLinksRequest struct {
	// To are the notes this one points at, already resolved by a reader who holds the keys.
	// The server drops any the caller cannot see rather than trusting the list.
	To []int64 `binding:"omitempty,max=500,dive,min=1" json:"to"`
}

type GraphNodeResponse struct {
	// Ref names the node inside this response. A visible node uses its file id; a locked
	// one uses an opaque counter, because handing out its id would make the graph an
	// existence oracle for notes every other route answers 404 for.
	Ref              string `json:"ref"                          example:"88"`
	FileID           int64  `json:"file_id,omitempty"            example:"88"`
	ClientID         string `json:"client_id,omitempty"`
	FolderID         *int64 `json:"folder_id,omitempty"`
	KeyScopeID       int64  `json:"key_scope_id,omitempty"`
	KeyScopeClientID string `json:"key_scope_client_id,omitempty"`
	KeyVersion       int32  `json:"key_version,omitempty"`
	Meta             []byte `json:"meta,omitempty"       format:"byte"`
	MetaNonce        []byte `json:"meta_nonce,omitempty" format:"byte"`
	Locked           bool   `json:"locked"                       example:"false"`
	Degree           int    `json:"degree"                       example:"4"`
}

type GraphEdgeResponse struct {
	From string `json:"from" example:"88"`
	To   string `json:"to"   example:"locked-1"`
}

type GraphResponse struct {
	Nodes []GraphNodeResponse `json:"nodes"`
	Edges []GraphEdgeResponse `json:"edges"`
	// Locked counts the masked nodes drawn. They exist so the picture is not a lie: a note
	// linked only through something invisible would otherwise appear unconnected.
	Locked int `json:"locked" example:"2"`
	// RevealsLocked says whether this vault draws masked nodes at all, so the view can tell
	// the reader whether they are looking at the whole graph or only their part of it.
	RevealsLocked bool `json:"reveals_locked" example:"true"`
}

type BacklinksResponse struct {
	Links []FileResponse `json:"links"`
	// Hidden counts the notes that point here and that the caller cannot see. A count and
	// never a list: the count is honest about the note's reach, the identities are not the
	// caller's to have.
	Hidden int `json:"hidden" example:"2"`
}

func graphResponse(graph *vault.Graph) GraphResponse {
	out := GraphResponse{
		Nodes:         make([]GraphNodeResponse, 0, len(graph.Nodes)),
		Edges:         make([]GraphEdgeResponse, 0, len(graph.Edges)),
		Locked:        graph.Locked,
		RevealsLocked: graph.RevealsLocked,
	}

	for _, node := range graph.Nodes {
		converted := GraphNodeResponse{
			Ref:              node.Ref,
			FileID:           node.FileID,
			ClientID:         node.ClientID,
			FolderID:         node.FolderID,
			KeyScopeID:       node.KeyScopeID,
			KeyScopeClientID: node.KeyScopeClientID,
			KeyVersion:       node.KeyVersion,
			Locked:           node.Locked,
			Degree:           node.Degree,
		}

		if node.Meta != nil {
			converted.Meta = node.Meta.Ciphertext
			converted.MetaNonce = node.Meta.Nonce
		}

		out.Nodes = append(out.Nodes, converted)
	}

	for _, edge := range graph.Edges {
		out.Edges = append(out.Edges, GraphEdgeResponse{From: edge.From, To: edge.To})
	}

	return out
}

func backlinksResponse(found *vault.Backlinks) BacklinksResponse {
	// Without the bodies: a panel that lists what points here has no use for the contents
	// of every note that does, and shipping them would make one click pull the vault.
	links := make([]FileResponse, 0, len(found.Visible))

	for i := range found.Visible {
		links = append(links, fileResponse(&found.Visible[i], false))
	}

	return BacklinksResponse{Links: links, Hidden: found.Hidden}
}

// -- revisions ---------------------------------------------------------------

type RevisionResponse struct {
	ID               int64  `json:"id"                   example:"14"`
	FileID           int64  `json:"file_id"              example:"88"`
	KeyScopeID       int64  `json:"key_scope_id"         example:"3"`
	KeyScopeClientID string `json:"key_scope_client_id"`
	KeyVersion       int32  `json:"key_version"          example:"2"`
	ContentSeq       int64  `json:"content_seq"          example:"14"`
	ContentSize      int    `json:"content_size"         example:"4112"`
	AuthorID         *int64 `json:"author_id,omitempty"`
	AuthorLogin      string `json:"author_login,omitempty"`
	AuthorName       string `json:"author_name,omitempty"`
	// AuthorPublicKey is what the signature verifies against. It travels with the revision
	// so checking who wrote it never depends on a second answer from the same server.
	AuthorPublicKey []byte `json:"author_public_key,omitempty" format:"byte"`
	Signature       []byte `json:"signature,omitempty"         format:"byte"`
	// Signed is false for a body written before signatures existed. Unsigned is not the
	// same as forged, but it is not proof of authorship either, and the view says so.
	Signed       bool      `json:"signed"                  example:"true"`
	Content      []byte    `json:"content,omitempty"       format:"byte"`
	ContentNonce []byte    `json:"content_nonce,omitempty" format:"byte"`
	CreatedAt    time.Time `json:"created_at"`
}

type RevisionsResponse struct {
	Revisions []RevisionResponse `json:"revisions"`
}

func revisionResponse(revision *vault.Revision, withBody bool) RevisionResponse {
	out := RevisionResponse{
		ID:               revision.ID,
		FileID:           revision.FileID,
		KeyScopeID:       revision.KeyScopeID,
		KeyScopeClientID: revision.KeyScopeClientID,
		KeyVersion:       revision.KeyVersion,
		ContentSeq:       revision.ContentSeq,
		ContentSize:      revision.ContentSize,
		AuthorID:         revision.AuthorID,
		AuthorLogin:      revision.AuthorLogin,
		AuthorName:       revision.AuthorName,
		AuthorPublicKey:  revision.AuthorPublicKey,
		Signature:        revision.Signature,
		Signed:           revision.Signed(),
		CreatedAt:        revision.CreatedAt,
	}

	if withBody {
		out.Content = revision.Content.Ciphertext
		out.ContentNonce = revision.Content.Nonce
	}

	return out
}

func revisionsResponse(list []vault.Revision) RevisionsResponse {
	out := RevisionsResponse{Revisions: make([]RevisionResponse, 0, len(list))}

	for i := range list {
		out.Revisions = append(out.Revisions, revisionResponse(&list[i], false))
	}

	return out
}

// -- share links -------------------------------------------------------------

type createShareRequest struct {
	// TokenHash is the digest of a secret the server never sees, the same shape as a code
	// invite. The secret travels in the link fragment and stays in the visitor's browser.
	TokenHash []byte `binding:"required,min=32,max=64" json:"token_hash" format:"byte"`
	// The note re-encrypted under a key derived from that secret. Not the scope key: a
	// scope covers a whole folder or vault, and one published note must not be the key to
	// everything sealed beside it.
	Meta         []byte     `binding:"required,min=16,max=8192"     json:"meta"          format:"byte"`
	MetaNonce    []byte     `binding:"required,min=12,max=32"       json:"meta_nonce"    format:"byte"`
	Content      []byte     `binding:"required,min=16,max=4194304"  json:"content"       format:"byte"`
	ContentNonce []byte     `binding:"required,min=12,max=32"       json:"content_nonce" format:"byte"`
	ContentSeq   int64      `binding:"required,min=1"               json:"content_seq"`
	ExpiresAt    *time.Time `binding:"omitempty"                    json:"expires_at,omitempty"`
}

type lookupShareRequest struct {
	TokenHash []byte `binding:"required,min=32,max=64" json:"token_hash" format:"byte"`
}

type ShareLinkResponse struct {
	ID     int64 `json:"id"      example:"5"`
	FileID int64 `json:"file_id" example:"88"`
	// ContentSeq is the version that was published. A link is a snapshot, so a note that
	// has moved on since is something the owner should be able to see.
	ContentSeq   int64      `json:"content_seq"   example:"14"`
	CreatedBy    *int64     `json:"created_by,omitempty"`
	CreatorName  string     `json:"creator_name,omitempty"`
	Permission   string     `json:"permission"    example:"view"`
	Live         bool       `json:"live"          example:"true"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	RevokedAt    *time.Time `json:"revoked_at,omitempty"`
	LastViewedAt *time.Time `json:"last_viewed_at,omitempty"`
	ViewCount    int64      `json:"view_count"    example:"12"`
	CreatedAt    time.Time  `json:"created_at"`
}

type ShareLinksResponse struct {
	Links []ShareLinkResponse `json:"links"`
}

// PublicNoteResponse is everything an anonymous visitor receives: the published copy, as
// ciphertext, and when it was taken. No vault, no folder, no author, and nothing that opens
// anything except this one note.
type PublicNoteResponse struct {
	ClientID     string    `json:"client_id"`
	Meta         []byte    `json:"meta"          format:"byte"`
	MetaNonce    []byte    `json:"meta_nonce"    format:"byte"`
	Content      []byte    `json:"content"       format:"byte"`
	ContentNonce []byte    `json:"content_nonce" format:"byte"`
	PublishedAt  time.Time `json:"published_at"`
}

func shareLinkResponse(link *vault.ShareLink) ShareLinkResponse {
	return ShareLinkResponse{
		ID:           link.ID,
		FileID:       link.FileID,
		ContentSeq:   link.ContentSeq,
		CreatedBy:    link.CreatedBy,
		CreatorName:  link.CreatorName,
		Permission:   "view",
		Live:         link.Live(),
		ExpiresAt:    link.ExpiresAt,
		RevokedAt:    link.RevokedAt,
		LastViewedAt: link.LastViewedAt,
		ViewCount:    link.ViewCount,
		CreatedAt:    link.CreatedAt,
	}
}

func shareLinksResponse(links []vault.ShareLink) ShareLinksResponse {
	out := ShareLinksResponse{Links: make([]ShareLinkResponse, 0, len(links))}

	for i := range links {
		out.Links = append(out.Links, shareLinkResponse(&links[i]))
	}

	return out
}

func publicNoteResponse(note *vault.PublicNote) PublicNoteResponse {
	return PublicNoteResponse{
		ClientID:     note.ClientID,
		Meta:         note.Meta.Ciphertext,
		MetaNonce:    note.Meta.Nonce,
		Content:      note.Content.Ciphertext,
		ContentNonce: note.Content.Nonce,
		PublishedAt:  note.PublishedAt,
	}
}
