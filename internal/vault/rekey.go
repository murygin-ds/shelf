package vault

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// RekeyTTL bounds how long a half-staged job may sit before it can be replaced. A tab that
// dies mid-way must not lock a folder against re-keying forever.
const RekeyTTL = time.Hour

// MaxRekeyBatch bounds one staging call. The limit is on rows rather than bytes because
// the body size is already capped by the HTTP layer.
const MaxRekeyBatch = 200

// RekeyStatus tracks a job through its one-way life.
type RekeyStatus string

const (
	RekeyStaging   RekeyStatus = "staging"
	RekeyCommitted RekeyStatus = "committed"
	RekeyAborted   RekeyStatus = "aborted"
)

// Rekey is a re-encryption job over one scope.
//
// It covers two operations that are the same underneath: giving a node its own key so a
// denial stops being a matter of the server's good behaviour, and rotating an existing key
// after somebody lost access.
type Rekey struct {
	ID         int64
	VaultID    int64
	ScopeType  ScopeType
	ScopeRefID int64
	// ScopeClientID names the scope the new key will belong to: the one being rotated, or
	// the one the commit is about to create. The client picks the latter before the row
	// exists, because the sealed keys and the additional data both have to name it.
	ScopeClientID string
	FromVersion   int32
	ToVersion     int32
	Status        RekeyStatus
	ExpiresAt     time.Time
}

// RekeyPlan is what a client needs to carry the job out: which rows to re-encrypt and
// whose keys to seal the new one to.
type RekeyPlan struct {
	Rekey
	// Creates reports whether this makes a new scope rather than rotating an existing one.
	Creates bool
	// Vault reports that the vault's own metadata is part of the job. It is sealed under the
	// vault scope like anything else, and a rotation that skipped it would leave the name
	// readable under the version it just retired.
	Vault    bool
	Folders  []int64
	Files    []int64
	Subjects []RekeySubject
}

// RekeySubject is somebody who keeps access after the job commits.
type RekeySubject struct {
	UserID      int64
	Login       string
	DisplayName string
	PublicKey   []byte
}

// RekeyItem is one re-encrypted row waiting for the commit.
type RekeyItem struct {
	EntityType ScopeType
	EntityID   int64
	Meta       Blob
	Content    *Blob
}

// RekeyGrant is the new scope key sealed to one subject.
type RekeyGrant struct {
	Subject    Subject
	WrappedKey []byte
	Nonce      []byte
	Algorithm  string
}

// NewRekey starts a job.
type NewRekey struct {
	VaultID          int64
	ScopeType        ScopeType
	ScopeRefID       int64
	NewScopeClientID string
	ActorID          int64
	ExpiresAt        time.Time
}

// RekeyRepository stores the job and applies its commit.
type RekeyRepository interface {
	StartRekey(ctx context.Context, in NewRekey) (*RekeyPlan, error)
	Rekey(ctx context.Context, rekeyID int64) (*Rekey, error)
	StageRekeyItems(ctx context.Context, rekeyID int64, items []RekeyItem) error
	// CommitRekey swaps the staged ciphertext in, writes the new key grants and drops the
	// grants of anyone who no longer belongs — all in one transaction, because a partially
	// applied re-key leaves rows nobody can read.
	CommitRekey(ctx context.Context, rekeyID, actorID int64, grants []RekeyGrant) (*KeyScope, error)
	AbortRekey(ctx context.Context, rekeyID int64) error
}

// StartRekey plans a re-encryption. Only somebody who can manage the node may start one,
// and only somebody holding its current key can actually carry it out — the server checks
// the first and cannot check the second.
func (s *Service) StartRekey(ctx context.Context, userID int64, in NewRekey) (*RekeyPlan, error) {
	if err := s.ownsTarget(ctx, userID, in.ScopeType, in.ScopeRefID, in.VaultID); err != nil {
		return nil, err
	}

	in.ActorID = userID
	in.ExpiresAt = time.Now().Add(RekeyTTL)

	plan, err := s.rekeys.StartRekey(ctx, in)
	if err != nil {
		return nil, translate(err, "start rekey")
	}

	s.log.Info("rekey started",
		zap.Int64("vault_id", in.VaultID),
		zap.String("scope_type", string(in.ScopeType)),
		zap.Int64("scope_ref_id", in.ScopeRefID),
		zap.Int("folders", len(plan.Folders)),
		zap.Int("files", len(plan.Files)),
		zap.Bool("creates_scope", plan.Creates),
	)

	return plan, nil
}

func (s *Service) StageRekeyItems(ctx context.Context, userID, rekeyID int64, items []RekeyItem) error {
	if len(items) == 0 || len(items) > MaxRekeyBatch {
		return ErrRekeyBatch
	}

	job, err := s.rekeyFor(ctx, userID, rekeyID)
	if err != nil {
		return err
	}

	if err := s.rekeys.StageRekeyItems(ctx, job.ID, items); err != nil {
		return translate(err, "stage rekey items")
	}

	return nil
}

// CommitRekey applies the job. Everything lands together: the new key version, the swapped
// ciphertext and the grants. Applying any part alone would leave rows sealed under a key
// nobody has been given.
func (s *Service) CommitRekey(
	ctx context.Context,
	userID, rekeyID int64,
	grants []RekeyGrant,
) (*KeyScope, error) {
	job, err := s.rekeyFor(ctx, userID, rekeyID)
	if err != nil {
		return nil, err
	}

	if len(grants) == 0 {
		return nil, ErrKeyGrantMissing
	}

	scope, err := s.rekeys.CommitRekey(ctx, job.ID, userID, grants)
	if err != nil {
		return nil, translate(err, "commit rekey")
	}

	return scope, nil
}

func (s *Service) AbortRekey(ctx context.Context, userID, rekeyID int64) error {
	job, err := s.rekeyFor(ctx, userID, rekeyID)
	if err != nil {
		return err
	}

	if err := s.rekeys.AbortRekey(ctx, job.ID); err != nil {
		return translate(err, "abort rekey")
	}

	return nil
}

func (s *Service) rekeyFor(ctx context.Context, userID, rekeyID int64) (*Rekey, error) {
	job, err := s.rekeys.Rekey(ctx, rekeyID)
	if err != nil {
		return nil, translate(err, "read rekey")
	}

	if job.Status != RekeyStaging {
		return nil, ErrRekeyStale
	}

	if time.Now().After(job.ExpiresAt) {
		return nil, ErrRekeyStale
	}

	if err := s.ownsTarget(ctx, userID, job.ScopeType, job.ScopeRefID, job.VaultID); err != nil {
		return nil, err
	}

	return job, nil
}

// ownsTarget checks the caller may re-key the node. A vault scope belongs to whoever
// manages the vault; a folder or note needs the strongest permission on that node.
func (s *Service) ownsTarget(
	ctx context.Context,
	userID int64,
	scopeType ScopeType,
	scopeRefID, vaultID int64,
) error {
	if scopeType == ScopeVault {
		member, err := s.member(ctx, vaultID, userID)
		if err != nil {
			return err
		}

		if !member.Role.Manages() {
			return ErrForbidden
		}

		return nil
	}

	var ref *Ref
	var err error

	switch scopeType {
	case ScopeFolder:
		ref, err = s.folderFor(ctx, userID, scopeRefID, PermOwn)
	case ScopeFile:
		ref, err = s.fileFor(ctx, userID, scopeRefID, PermOwn)
	default:
		return ErrNotFound
	}

	if err != nil {
		return err
	}

	if ref.VaultID != vaultID {
		return ErrNotFound
	}

	return nil
}
