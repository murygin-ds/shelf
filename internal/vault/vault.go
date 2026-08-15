// Package vault implements the encrypted workspace: vaults, folders and notes.
//
// The server stores ciphertext and never holds a key that opens it. What it does own is
// the structure — the tree, the membership, the permissions and the change sequence — and
// every decision in this package follows from that split.
package vault

import (
	"context"
	"errors"
	"time"
)

// Business logic errors. The HTTP layer translates them into response codes.
var (
	ErrNotFound = errors.New("not found")
	// ErrForbidden is only returned when the caller can already see the parent. A resource
	// they cannot see at all answers ErrNotFound, so ids do not become an existence oracle.
	ErrForbidden = errors.New("forbidden")
	// ErrVersionConflict means a write carried a stale content sequence. The server cannot
	// merge ciphertext, so the client has to resolve it.
	ErrVersionConflict = errors.New("content was changed by someone else")
	// ErrScopeMismatch means the ciphertext was sealed under a key that does not belong
	// where it is being written, which would leave the row unreadable.
	ErrScopeMismatch = errors.New("key scope does not match the destination")
	ErrCycle         = errors.New("a folder cannot be moved into itself")
	ErrDepthExceeded = errors.New("folder tree is too deep")
	ErrOwnerRequired = errors.New("a vault must keep an owner")
)

// MaxDepth mirrors the CHECK on folders.depth. It bounds the recursive descent.
const MaxDepth = 32

// DefaultWrapAlgorithm is the sealed-box format the client uses today.
const DefaultWrapAlgorithm = "ecdh-p256-hkdf-a256gcm"

// Blob is a client-encrypted payload together with the nonce it was sealed under.
type Blob struct {
	Ciphertext []byte
	Nonce      []byte
}

// ScopeType is the kind of node that owns a content key.
type ScopeType string

const (
	ScopeVault  ScopeType = "vault"
	ScopeFolder ScopeType = "folder"
	ScopeFile   ScopeType = "file"
)

// KeyScope owns one content key. Every folder and note is encrypted under the scope it
// points at, which is the vault's own scope until access is narrowed.
type KeyScope struct {
	ID         int64
	ClientID   string
	VaultID    int64
	Type       ScopeType
	RefID      int64
	KeyVersion int32
}

// ScopeStatus is a scope together with what the key status panel needs to show.
type ScopeStatus struct {
	KeyScope
	GrantCount int
	RotatedAt  time.Time
}

// SealedKey is a content key sealed to some subject's public key.
type SealedKey struct {
	WrappedKey []byte
	Nonce      []byte
	Algorithm  string
}

// KeyGrant is a sealed content key addressed to one subject at one key version.
type KeyGrant struct {
	ID      int64
	ScopeID int64
	// ScopeClientID names the scope inside the sealed box, so a grant cannot be replayed
	// against a different scope.
	ScopeClientID string
	KeyVersion    int32
	Subject       Subject
	SealedKey
}

// Membership is what a user is allowed to do in a vault before any grant narrows it.
type Membership struct {
	VaultID   int64
	UserID    int64
	Role      Role
	KeyState  KeyState
	AccessSeq int64
}

// KeyState tracks whether a member actually holds the keys their role implies.
type KeyState string

const (
	KeyStateOK              KeyState = "ok"
	KeyStatePendingKey      KeyState = "pending_key"
	KeyStatePendingRotation KeyState = "pending_rotation"
)

// Vault is a workspace. Its name and emoji live inside the encrypted meta blob.
type Vault struct {
	ID int64
	// ClientID is chosen by the client before the row exists, so the encrypted metadata
	// can be bound to a stable identity in one round trip. The serial id cannot serve:
	// it is only known after the insert.
	ClientID string
	OwnerID  int64
	Meta     Blob
	// ChangeSeq is the monotonic cursor every delta sync is measured against.
	ChangeSeq int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Summary is a vault as the switcher shows it: the counts and the caller's own standing.
type Summary struct {
	Vault
	Role        Role
	KeyState    KeyState
	KeyScopeID  int64
	KeyVersion  int32
	NoteCount   int
	MemberCount int
}

// Access is the caller-specific view of one node, resolved by the query that read it.
type Access struct {
	Permission Permission
	// OwnScope is true when the node owns its key scope rather than inheriting one.
	// Together with a grant count of one it is what the tree shows as a solo key.
	OwnScope   bool
	GrantCount int
}

// Folder is a node of the tree. Its name and icon live inside the encrypted meta blob.
type Folder struct {
	ID            int64
	ClientID      string
	VaultID       int64
	ParentID      *int64
	KeyScopeID    int64
	KeyVersion    int32
	Meta          Blob
	InheritAccess bool
	Depth         int32
	Position      int32
	UpdatedSeq    int64
	UpdatedBy     *int64
	DeletedAt     *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Access        Access
}

// File is a note. Its title and icon live in meta, its body in content.
type File struct {
	ID            int64
	ClientID      string
	VaultID       int64
	FolderID      *int64
	KeyScopeID    int64
	KeyVersion    int32
	Meta          Blob
	Content       Blob
	ContentSeq    int64
	ContentSize   int
	InheritAccess bool
	UpdatedSeq    int64
	UpdatedBy     *int64
	DeletedAt     *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Access        Access
}

// Ref is the minimum a write needs to know about its target: where it lives, what the
// caller may do to it, and which key its ciphertext must be sealed under.
type Ref struct {
	VaultID    int64
	ID         int64
	Permission Permission
	KeyScopeID int64
	KeyVersion int32
	Deleted    bool
}

// NewVault creates a workspace together with its scope and the owner's own key grant.
type NewVault struct {
	ClientID string
	// ScopeClientID identifies the vault's own key scope, which the owner's key grant is
	// sealed against before the scope row exists.
	ScopeClientID string
	OwnerID       int64
	Meta          Blob
	// Key is the vault content key sealed to the owner's public key. It is written in the
	// same transaction as the membership row, because a key grant without a matching
	// permission would be a standing backdoor.
	Key SealedKey
}

// NewFolder creates a folder under a parent, or at the vault root when ParentID is nil.
type NewFolder struct {
	ClientID string
	VaultID  int64
	ParentID *int64
	Meta     Blob
	Position int32
	// KeyScopeID and KeyVersion are what the client sealed Meta under. The service refuses
	// them when they differ from the destination's effective scope.
	KeyScopeID int64
	KeyVersion int32
}

// NewFile creates a note inside a folder, or at the vault root when FolderID is nil.
type NewFile struct {
	ClientID   string
	VaultID    int64
	FolderID   *int64
	Meta       Blob
	Content    Blob
	KeyScopeID int64
	KeyVersion int32
}

// MetaUpdate renames a node or changes its icon: both live in the same blob.
type MetaUpdate struct {
	Meta     Blob
	Position *int32
}

// ContentUpdate replaces a note body under an optimistic lock.
type ContentUpdate struct {
	Content Blob
	// ExpectedSeq is the content_seq the client last saw. A mismatch is a conflict, not a
	// merge: nobody but the client can read either version.
	ExpectedSeq int64
}

// Move relocates a node within its vault.
type Move struct {
	ParentID *int64
	Position int32
}

// Repository stores vaults, membership and key grants.
type Repository interface {
	CreateVault(ctx context.Context, in NewVault) (*Vault, error)
	Vault(ctx context.Context, vaultID int64) (*Vault, error)
	VaultsByMember(ctx context.Context, userID int64) ([]Summary, error)
	UpdateVaultMeta(ctx context.Context, vaultID int64, meta Blob) error
	DeleteVault(ctx context.Context, vaultID int64) error

	Membership(ctx context.Context, vaultID, userID int64) (*Membership, error)
	// KeyGrants returns every grant the user can open across the vault, at every version,
	// so one round trip bootstraps the whole keyring.
	KeyGrants(ctx context.Context, vaultID, userID int64) ([]KeyGrant, error)
	Scopes(ctx context.Context, vaultID int64) ([]ScopeStatus, error)
}

// FolderRepository stores the tree.
type FolderRepository interface {
	CreateFolder(ctx context.Context, in NewFolder, actorID int64) (*Folder, error)
	Folder(ctx context.Context, folderID, userID int64) (*Folder, error)
	// FolderRef resolves a folder for a write without loading its ciphertext.
	FolderRef(ctx context.Context, folderID, userID int64) (*Ref, error)
	UpdateFolderMeta(ctx context.Context, folderID int64, in MetaUpdate, actorID int64) (*Folder, error)
	MoveFolder(ctx context.Context, folderID int64, in Move, actorID int64) (*Folder, error)
	// IsDescendant guards a move against building a cycle the resolution query would spin on.
	IsDescendant(ctx context.Context, folderID, candidateAncestorID int64) (bool, error)
	SetFolderDeleted(ctx context.Context, folderID int64, deleted bool, actorID int64) error
	PurgeFolder(ctx context.Context, folderID int64) error
}

// FileRepository stores the notes.
type FileRepository interface {
	CreateFile(ctx context.Context, in NewFile, actorID int64) (*File, error)
	File(ctx context.Context, fileID, userID int64) (*File, error)
	FileRef(ctx context.Context, fileID, userID int64) (*Ref, error)
	Files(ctx context.Context, vaultID, userID int64, ids []int64) ([]File, error)
	UpdateFileMeta(ctx context.Context, fileID int64, in MetaUpdate, actorID int64) (*File, error)
	UpdateFileContent(ctx context.Context, fileID int64, in ContentUpdate, actorID int64) (*File, error)
	MoveFile(ctx context.Context, fileID int64, in Move, actorID int64) (*File, error)
	SetFileDeleted(ctx context.Context, fileID int64, deleted bool, actorID int64) error
	PurgeFile(ctx context.Context, fileID int64) error
}

// TreeRepository reads the tree the caller can see.
type TreeRepository interface {
	// Tree returns every folder and note the caller may view, with their effective
	// permission already resolved.
	Tree(ctx context.Context, vaultID, userID int64, deleted bool) ([]Folder, []File, error)
	// ParentRef resolves the destination of a create or a move: the vault root when
	// folderID is nil, otherwise the folder itself.
	ParentRef(ctx context.Context, vaultID, userID int64, folderID *int64) (*Ref, error)
}
