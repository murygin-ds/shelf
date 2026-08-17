package vault_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"shelf/internal/vault"

	"go.uber.org/zap"
)

// fakeStore stands in for every repository the service drives. It records what it was
// handed rather than doing anything with it: these tests are about the decisions the
// service makes before the storage layer is reached at all.
type fakeStore struct {
	membership *vault.Membership
	memberErr  error

	fileRef *vault.Ref
	fileErr error

	delta *vault.Delta
	// lastLimit is what Sync actually asked for after clamping.
	lastLimit int

	rekey *vault.Rekey

	link      *vault.ShareLink
	lastShare vault.NewShareLink
	// created and revoked count what reached storage, so a refusal upstream is visible.
	created int
	revoked int
}

func (f *fakeStore) Membership(context.Context, int64, int64) (*vault.Membership, error) {
	if f.memberErr != nil {
		return nil, f.memberErr
	}

	return f.membership, nil
}

func (f *fakeStore) Sync(_ context.Context, _, _, _ int64, limit int) (*vault.Delta, error) {
	f.lastLimit = limit

	return f.delta, nil
}

func (f *fakeStore) FileRef(context.Context, int64, int64) (*vault.Ref, error) {
	if f.fileErr != nil {
		return nil, f.fileErr
	}

	return f.fileRef, nil
}

func (f *fakeStore) Rekey(context.Context, int64) (*vault.Rekey, error) { return f.rekey, nil }

func (f *fakeStore) StartRekey(context.Context, vault.NewRekey) (*vault.RekeyPlan, error) {
	return &vault.RekeyPlan{}, nil
}

func (f *fakeStore) StageRekeyItems(context.Context, int64, []vault.RekeyItem) error { return nil }

func (f *fakeStore) CommitRekey(context.Context, int64, int64, []vault.RekeyGrant) (*vault.KeyScope, error) {
	return &vault.KeyScope{}, nil
}

func (f *fakeStore) AbortRekey(context.Context, int64) error { return nil }

func (f *fakeStore) CreateShareLink(_ context.Context, in vault.NewShareLink, _ int64) (*vault.ShareLink, error) {
	f.lastShare = in
	f.created++

	return f.link, nil
}

func (f *fakeStore) ShareLinks(context.Context, int64) ([]vault.ShareLink, error) { return nil, nil }

func (f *fakeStore) ShareLink(context.Context, int64) (*vault.ShareLink, error) { return f.link, nil }

func (f *fakeStore) RevokeShareLink(context.Context, int64, int64) error {
	f.revoked++

	return nil
}

func (f *fakeStore) PublicNote(context.Context, []byte) (*vault.PublicNote, error) {
	return &vault.PublicNote{}, nil
}

// service wires the fake in as every repository the paths under test touch. The ones they
// never reach stay nil on purpose: a nil dereference is a clearer failure than a silent
// stub answering a question the test did not mean to ask.
func service(f *fakeStore) *vault.Service {
	return vault.NewService(vault.Deps{
		Vaults: stubVaults{f},
		Files:  stubFiles{f},
		Sync:   f,
		Rekeys: f,
		Shares: f,
		Logger: zap.NewNop(),
	})
}

type stubVaults struct{ *fakeStore }

func (s stubVaults) CreateVault(context.Context, vault.NewVault) (*vault.Vault, error) {
	panic("not reached")
}
func (s stubVaults) VaultsByMember(context.Context, int64) ([]vault.Summary, error) {
	panic("not reached")
}
func (s stubVaults) Vault(context.Context, int64) (*vault.Vault, error)       { panic("not reached") }
func (s stubVaults) UpdateVaultMeta(context.Context, int64, vault.Blob) error { panic("not reached") }
func (s stubVaults) SetMemberLabel(context.Context, int64, int64, *vault.Blob) error {
	panic("not reached")
}
func (s stubVaults) DeleteVault(context.Context, int64) error { panic("not reached") }
func (s stubVaults) KeyGrants(context.Context, int64, int64) ([]vault.KeyGrant, error) {
	panic("not reached")
}
func (s stubVaults) Scopes(context.Context, int64) ([]vault.ScopeStatus, error) {
	panic("not reached")
}

type stubFiles struct{ *fakeStore }

func (s stubFiles) CreateFile(context.Context, vault.NewFile, int64) (*vault.File, error) {
	panic("not reached")
}
func (s stubFiles) File(context.Context, int64, int64) (*vault.File, error) { panic("not reached") }
func (s stubFiles) Files(context.Context, int64, int64, []int64) ([]vault.File, error) {
	panic("not reached")
}
func (s stubFiles) UpdateFileMeta(context.Context, int64, vault.MetaUpdate, int64) (*vault.File, error) {
	panic("not reached")
}
func (s stubFiles) UpdateFileContent(context.Context, int64, vault.ContentUpdate, int64) (*vault.File, error) {
	panic("not reached")
}
func (s stubFiles) MoveFile(context.Context, int64, vault.Move, int64) (*vault.File, error) {
	panic("not reached")
}
func (s stubFiles) SetFileDeleted(context.Context, int64, bool, int64) error { panic("not reached") }
func (s stubFiles) PurgeFile(context.Context, int64) error                   { panic("not reached") }

// TestSyncDemandsAFullResync pins the one comparison that tells a client to drop plaintext
// it cached before it lost access to it. Nothing else in the system does that job.
func TestSyncDemandsAFullResync(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		accessSeq int64
		cursor    int64
		want      bool
	}{
		"access changed after the client last synced": {accessSeq: 90, cursor: 42, want: true},
		"the client is already past the change":       {accessSeq: 10, cursor: 42, want: false},
		"exactly at the boundary is not a resync":     {accessSeq: 42, cursor: 42, want: false},
		"a fresh client with no cursor":               {accessSeq: 1, cursor: 0, want: true},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			store := &fakeStore{
				membership: &vault.Membership{Role: vault.RoleEditor, AccessSeq: tc.accessSeq},
				delta:      &vault.Delta{Cursor: tc.cursor},
			}

			// The delta's own cursor is deliberately unrelated to the request cursor, so a
			// service comparing the wrong one shows up rather than coinciding.
			store.delta = &vault.Delta{Cursor: tc.cursor + 1000}

			delta, err := service(store).Sync(context.Background(), 1, 1, tc.cursor, 0)
			if err != nil {
				t.Fatalf("Sync: %v", err)
			}

			if delta.FullResync != tc.want {
				t.Fatalf("FullResync = %v, want %v", delta.FullResync, tc.want)
			}
		})
	}
}

func TestSyncClampsTheLimit(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		asked int
		want  int
	}{
		"zero falls back to the default":       {asked: 0, want: vault.DefaultSyncLimit},
		"negative falls back to the default":   {asked: -5, want: vault.DefaultSyncLimit},
		"a sane limit is passed through":       {asked: 25, want: 25},
		"a limit at the cap is passed through": {asked: vault.MaxSyncLimit, want: vault.MaxSyncLimit},
		"an absurd limit is capped":            {asked: vault.MaxSyncLimit + 1, want: vault.DefaultSyncLimit},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			store := &fakeStore{
				membership: &vault.Membership{Role: vault.RoleViewer},
				delta:      &vault.Delta{},
			}

			if _, err := service(store).Sync(context.Background(), 1, 1, 0, tc.asked); err != nil {
				t.Fatalf("Sync: %v", err)
			}

			if store.lastLimit != tc.want {
				t.Fatalf("limit reaching storage = %d, want %d", store.lastLimit, tc.want)
			}
		})
	}
}

// TestSyncRefusesANonMember pins that the membership check runs before anything is read:
// a vault the caller is not in is indistinguishable from one that does not exist.
func TestSyncRefusesANonMember(t *testing.T) {
	t.Parallel()

	store := &fakeStore{memberErr: vault.ErrNotFound, delta: &vault.Delta{}}

	if _, err := service(store).Sync(context.Background(), 1, 1, 0, 0); !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}

	if store.lastLimit != 0 {
		t.Fatal("storage was asked for a delta despite the membership check failing")
	}
}

func ownedNote() *vault.Ref {
	return &vault.Ref{VaultID: 1, ID: 2, Permission: vault.PermOwn, KeyScopeID: 3, KeyVersion: 1}
}

// TestShareLinkExpiry pins the two ends of the window. A link with no expiry is a
// credential nobody remembers issuing; one that has already expired is a URL that never
// worked, and handing it back would be worse than refusing.
func TestShareLinkExpiry(t *testing.T) {
	t.Parallel()

	t.Run("no expiry is clamped to the ceiling", func(t *testing.T) {
		t.Parallel()

		store := &fakeStore{fileRef: ownedNote(), link: &vault.ShareLink{}}

		_, err := service(store).CreateShareLink(context.Background(), 1, vault.NewShareLink{FileID: 2})
		if err != nil {
			t.Fatalf("CreateShareLink: %v", err)
		}

		if store.lastShare.ExpiresAt == nil {
			t.Fatal("a link reached storage with no expiry at all")
		}

		gap := time.Until(*store.lastShare.ExpiresAt)

		// Both ends: clamping to zero would satisfy an upper bound on its own.
		if gap > vault.MaxShareTTL || gap < vault.MaxShareTTL-time.Minute {
			t.Fatalf("expiry is %v away, want about %v", gap, vault.MaxShareTTL)
		}
	})

	t.Run("an expiry beyond the ceiling is brought back", func(t *testing.T) {
		t.Parallel()

		far := time.Now().Add(10 * vault.MaxShareTTL)
		store := &fakeStore{fileRef: ownedNote(), link: &vault.ShareLink{}}

		_, err := service(store).CreateShareLink(context.Background(), 1,
			vault.NewShareLink{FileID: 2, ExpiresAt: &far})
		if err != nil {
			t.Fatalf("CreateShareLink: %v", err)
		}

		gap := time.Until(*store.lastShare.ExpiresAt)
		if gap > vault.MaxShareTTL || gap < vault.MaxShareTTL-time.Minute {
			t.Fatalf("clamped expiry is %v away, want about %v", gap, vault.MaxShareTTL)
		}
	})

	t.Run("an expiry in the past is refused", func(t *testing.T) {
		t.Parallel()

		past := time.Now().Add(-time.Hour)
		store := &fakeStore{fileRef: ownedNote(), link: &vault.ShareLink{}}

		_, err := service(store).CreateShareLink(context.Background(), 1,
			vault.NewShareLink{FileID: 2, ExpiresAt: &past})

		if !errors.Is(err, vault.ErrShareExpiry) {
			t.Fatalf("err = %v, want ErrShareExpiry", err)
		}

		if store.created != 0 {
			t.Fatal("a dead link reached storage")
		}
	})
}

// TestPublishingNeedsOwnership pins who may publish. A public link outlives the reader who
// made it, so it is not an editor's decision.
func TestPublishingNeedsOwnership(t *testing.T) {
	t.Parallel()

	store := &fakeStore{
		fileRef: &vault.Ref{VaultID: 1, ID: 2, Permission: vault.PermEdit},
		link:    &vault.ShareLink{},
	}

	_, err := service(store).CreateShareLink(context.Background(), 1, vault.NewShareLink{FileID: 2})

	if !errors.Is(err, vault.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}

	if store.created != 0 {
		t.Fatal("an editor published a note")
	}
}

// TestRevokingSomebodyElsesLinkIs404 pins the deliberate substitution: a link id is not a
// handle on anything the caller could otherwise reach, so 403 would only confirm it exists.
func TestRevokingSomebodyElsesLinkIs404(t *testing.T) {
	t.Parallel()

	store := &fakeStore{
		link:    &vault.ShareLink{ID: 5, FileID: 2},
		fileRef: &vault.Ref{VaultID: 1, ID: 2, Permission: vault.PermView},
	}

	err := service(store).RevokeShareLink(context.Background(), 1, 5)

	if !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound rather than a 403 that confirms the link", err)
	}

	if store.revoked != 0 {
		t.Fatal("the link was revoked despite the caller not being allowed to")
	}
}

// TestShareLinkLiveness pins what the UI branches on.
func TestShareLinkLiveness(t *testing.T) {
	t.Parallel()

	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)

	cases := map[string]struct {
		link vault.ShareLink
		want bool
	}{
		"no expiry and never revoked": {link: vault.ShareLink{}, want: true},
		"expiring later":              {link: vault.ShareLink{ExpiresAt: &future}, want: true},
		"already expired":             {link: vault.ShareLink{ExpiresAt: &past}, want: false},
		"revoked":                     {link: vault.ShareLink{RevokedAt: &past}, want: false},
		"revoked beats a live expiry": {link: vault.ShareLink{ExpiresAt: &future, RevokedAt: &past}, want: false},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			if got := tc.link.Live(); got != tc.want {
				t.Fatalf("Live() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestAStaleRekeyIsRefused pins the three ways a job stops being usable. Staging into a
// committed job would write ciphertext nobody will ever apply.
func TestAStaleRekeyIsRefused(t *testing.T) {
	t.Parallel()

	item := []vault.RekeyItem{{EntityType: vault.ScopeFile, EntityID: 1}}

	cases := map[string]*vault.Rekey{
		"already committed": {
			VaultID: 1, ScopeType: vault.ScopeVault, ScopeRefID: 1,
			Status: vault.RekeyCommitted, ExpiresAt: time.Now().Add(time.Hour),
		},
		"aborted": {
			VaultID: 1, ScopeType: vault.ScopeVault, ScopeRefID: 1,
			Status: vault.RekeyAborted, ExpiresAt: time.Now().Add(time.Hour),
		},
		"left to expire": {
			VaultID: 1, ScopeType: vault.ScopeVault, ScopeRefID: 1,
			Status: vault.RekeyStaging, ExpiresAt: time.Now().Add(-time.Minute),
		},
	}

	for name, job := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			store := &fakeStore{
				rekey:      job,
				membership: &vault.Membership{Role: vault.RoleOwner},
			}

			if err := service(store).StageRekeyItems(context.Background(), 1, 1, item); !errors.Is(err, vault.ErrRekeyStale) {
				t.Fatalf("err = %v, want ErrRekeyStale", err)
			}
		})
	}
}

// TestTheBatchBoundIsCheckedFirst pins an ordering that is easy to get backwards: an
// oversized batch is refused before the job is even looked up, so a client cannot use the
// staging endpoint to probe which re-key ids exist.
func TestTheBatchBoundIsCheckedFirst(t *testing.T) {
	t.Parallel()

	oversized := make([]vault.RekeyItem, vault.MaxRekeyBatch+1)
	store := &fakeStore{rekey: nil, membership: &vault.Membership{Role: vault.RoleOwner}}

	if err := service(store).StageRekeyItems(context.Background(), 1, 1, oversized); !errors.Is(err, vault.ErrRekeyBatch) {
		t.Fatalf("err = %v, want ErrRekeyBatch", err)
	}

	if err := service(store).StageRekeyItems(context.Background(), 1, 1, nil); !errors.Is(err, vault.ErrRekeyBatch) {
		t.Fatalf("empty batch err = %v, want ErrRekeyBatch", err)
	}
}

// TestOnlyAManagerRekeysAVault pins that rotating the key of a whole vault is not an
// editor's call, even though editing every note in it is.
func TestOnlyAManagerRekeysAVault(t *testing.T) {
	t.Parallel()

	store := &fakeStore{
		rekey: &vault.Rekey{
			VaultID: 1, ScopeType: vault.ScopeVault, ScopeRefID: 1,
			Status: vault.RekeyStaging, ExpiresAt: time.Now().Add(time.Hour),
		},
		membership: &vault.Membership{Role: vault.RoleEditor},
	}

	err := service(store).AbortRekey(context.Background(), 1, 1)

	if !errors.Is(err, vault.ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}
