package access_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	domain "shelf/internal/access"
	"shelf/internal/api/middleware"
	"shelf/internal/api/response"
	handler "shelf/internal/api/v1/access"
	"shelf/internal/ratelimit"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const testUserID int64 = 42

type stubService struct {
	err error

	members   []domain.Member
	directory *domain.Directory
	grants    []domain.Grant
	grant     *domain.Grant
	invites   []domain.Invite
	invite    *domain.Invite
	challenge *domain.Challenge
	scopes    []int64

	groups    []domain.Group
	group     *domain.Group
	groupKeys []domain.GroupKey

	lastGrant   domain.GrantInput
	lastInvite  domain.NewInvite
	lastRedeem  domain.Redemption
	lastGroup   domain.NewGroup
	lastMembers domain.GroupMembership
}

func (s *stubService) Members(context.Context, int64, int64) ([]domain.Member, error) {
	return s.members, s.err
}
func (s *stubService) Lookup(context.Context, string) (*domain.Directory, error) {
	return s.directory, s.err
}
func (s *stubService) SetRole(context.Context, int64, int64, int64, vault.Role) error { return s.err }
func (s *stubService) RemoveMember(context.Context, int64, int64, int64) ([]int64, error) {
	return s.scopes, s.err
}
func (s *stubService) Leave(context.Context, int64, int64) ([]int64, error) {
	return s.scopes, s.err
}
func (s *stubService) Grants(context.Context, int64, int64, vault.ScopeType, int64) ([]domain.Grant, error) {
	return s.grants, s.err
}
func (s *stubService) PutGrant(_ context.Context, _ int64, in domain.GrantInput) (*domain.Grant, error) {
	s.lastGrant = in
	return s.grant, s.err
}
func (s *stubService) DeleteGrant(context.Context, int64, int64, int64) error { return s.err }
func (s *stubService) CreateInvite(_ context.Context, _ int64, in domain.NewInvite) (*domain.Invite, error) {
	s.lastInvite = in
	return s.invite, s.err
}
func (s *stubService) Invites(context.Context, int64, int64) ([]domain.Invite, error) {
	return s.invites, s.err
}
func (s *stubService) MyInvites(context.Context, int64) ([]domain.Invite, error) {
	return s.invites, s.err
}
func (s *stubService) RevokeInvite(context.Context, int64, int64, int64) error { return s.err }
func (s *stubService) Groups(context.Context, int64, int64) ([]domain.Group, error) {
	return s.groups, s.err
}
func (s *stubService) CreateGroup(_ context.Context, _ int64, in domain.NewGroup) (*domain.Group, error) {
	s.lastGroup = in
	return s.group, s.err
}
func (s *stubService) UpdateGroup(context.Context, int64, int64, vault.Blob) error { return s.err }
func (s *stubService) DeleteGroup(context.Context, int64, int64) error             { return s.err }
func (s *stubService) SetGroupMembers(_ context.Context, _ int64, in domain.GroupMembership) (*domain.Group, error) {
	s.lastMembers = in
	return s.group, s.err
}
func (s *stubService) GroupKeys(context.Context, int64, int64) ([]domain.GroupKey, error) {
	return s.groupKeys, s.err
}
func (s *stubService) GroupScopes(context.Context, int64, int64) ([]domain.GroupScope, error) {
	return nil, s.err
}
func (s *stubService) Challenge(context.Context, []byte) (*domain.Challenge, error) {
	return s.challenge, s.err
}
func (s *stubService) Redeem(_ context.Context, _ int64, in domain.Redemption) (*domain.Invite, error) {
	s.lastRedeem = in
	return s.invite, s.err
}

func newTestRouter(t *testing.T, service handler.Service) *gin.Engine {
	t.Helper()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	public := router.Group("/api/v1")
	protected := router.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextUserID, testUserID)
		c.Next()
	})

	handler.NewHandler(service, ratelimit.Nop{}, zap.NewNop()).RegisterRoutes(public, protected)

	return router
}

func doJSON(t *testing.T, router *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()

	var reader *bytes.Reader

	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}

		reader = bytes.NewReader(raw)
	}

	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	return rec
}

func digest() []byte { return bytes.Repeat([]byte{7}, 32) }

func sealedKey() map[string]any {
	return map[string]any{
		"scope_id":    1,
		"key_version": 1,
		"wrapped_key": bytes.Repeat([]byte{1}, 113),
		"nonce":       bytes.Repeat([]byte{2}, 12),
	}
}

func reasonOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()

	var body response.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body, err)
	}

	return body.Error.Details[response.ReasonKey]
}

// TestInviteFailuresAreIndistinguishable is the whole point of the lookup endpoint's
// design: expired, revoked, already used and never existed have to look identical, or the
// endpoint becomes a way to test guesses at a code.
func TestInviteFailuresAreIndistinguishable(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{err: domain.ErrInviteInvalid})

	lookup := doJSON(t, router, http.MethodPost, "/api/v1/invites/lookup",
		map[string]any{"token_hash": digest()})

	redeem := doJSON(t, router, http.MethodPost, "/api/v1/invites/redeem",
		map[string]any{"token_hash": digest(), "key_grants": []any{sealedKey()}})

	for name, rec := range map[string]*httptest.ResponseRecorder{"lookup": lookup, "redeem": redeem} {
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want %d (body: %s)", name, rec.Code, http.StatusNotFound, rec.Body)
		}

		var body response.ErrorResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s unmarshal: %v", name, err)
		}

		if body.Error.Message != "not found" {
			t.Fatalf("%s message = %q, want a message that says nothing", name, body.Error.Message)
		}

		// The reason is the easier field to read, so it has to say as little as the message.
		if got := body.Error.Details[response.ReasonKey]; got != response.ReasonNotFound {
			t.Fatalf("%s reason = %q, want %q", name, got, response.ReasonNotFound)
		}
	}

	// And identical to an invite that never existed, down to the bytes.
	missing := doJSON(t, newTestRouter(t, &stubService{err: domain.ErrNotFound}), http.MethodPost,
		"/api/v1/invites/lookup", map[string]any{"token_hash": digest()})

	if missing.Body.String() != lookup.Body.String() {
		t.Fatalf("an invalid code answers %s, a missing one %s", lookup.Body, missing.Body)
	}
}

func TestLookupIsOpenToAnonymousCallers(t *testing.T) {
	t.Parallel()

	// Whoever is redeeming a code may have no account yet, so the lookup cannot require
	// one. It returns ciphertext only, which is why that is safe.
	service := &stubService{challenge: &domain.Challenge{
		InviteID: 4,
		Preview:  vault.Blob{Ciphertext: []byte("sealed"), Nonce: []byte("nonce")},
		Keys:     []domain.SealedKey{{ScopeID: 1, KeyVersion: 1}},
	}}

	rec := doJSON(t, newTestRouter(t, service), http.MethodPost, "/api/v1/invites/lookup",
		map[string]any{"token_hash": digest()})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body handler.ChallengeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Nothing about the vault may travel in the clear here: the name lives inside the
	// preview, encrypted under the same code.
	if bytes.Contains(rec.Body.Bytes(), []byte("vault_id")) || bytes.Contains(rec.Body.Bytes(), []byte("\"role\"")) {
		t.Fatalf("the challenge describes the vault: %s", rec.Body)
	}

	if len(body.Keys) != 1 {
		t.Fatalf("keys = %d, want 1", len(body.Keys))
	}
}

func TestInviteNeedsExactlyOnePath(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{invite: &domain.Invite{ID: 1}})

	both := map[string]any{
		"token_hash":     digest(),
		"target_user_id": 7,
		"role":           "editor",
		"key_grants":     []any{sealedKey()},
	}

	neither := map[string]any{"role": "editor", "key_grants": []any{sealedKey()}}

	for name, body := range map[string]map[string]any{"both": both, "neither": neither} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, router, http.MethodPost, "/api/v1/vaults/1/invites", body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
			}

			if got := reasonOf(t, rec); got != response.ReasonInvitePath {
				t.Fatalf("reason = %q, want %q", got, response.ReasonInvitePath)
			}
		})
	}
}

// Redemption has the same rule as issuance, and its own reason: the client asks for a code
// or for an invite it can already see, never both.
func TestRedeemNeedsExactlyOnePath(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{invite: &domain.Invite{ID: 1}})

	both := map[string]any{
		"token_hash": digest(),
		"invite_id":  4,
		"key_grants": []any{sealedKey()},
	}

	neither := map[string]any{"key_grants": []any{sealedKey()}}

	for name, body := range map[string]map[string]any{"both": both, "neither": neither} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, router, http.MethodPost, "/api/v1/invites/redeem", body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
			}

			if got := reasonOf(t, rec); got != response.ReasonRedeemPath {
				t.Fatalf("reason = %q, want %q", got, response.ReasonRedeemPath)
			}
		})
	}
}

func TestInviteRejectsOwnerRole(t *testing.T) {
	t.Parallel()

	// A vault has exactly one owner and it is the account that created it. Admitting a
	// second one sideways would be a way to take a vault over.
	rec := doJSON(t, newTestRouter(t, &stubService{}), http.MethodPost, "/api/v1/vaults/1/invites",
		map[string]any{"token_hash": digest(), "role": "owner", "key_grants": []any{sealedKey()}})

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
	}
}

func TestGrantCarriesItsKeys(t *testing.T) {
	t.Parallel()

	service := &stubService{grant: &domain.Grant{ID: 3, Permission: vault.PermEdit}}
	router := newTestRouter(t, service)

	rec := doJSON(t, router, http.MethodPut, "/api/v1/vaults/9/grants", map[string]any{
		"scope_type":   "folder",
		"scope_ref_id": 12,
		"subject_type": "user",
		"subject_id":   7,
		"permission":   "edit",
		"key_grants":   []any{sealedKey()},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	// The keys have to reach the service intact: they are what turns a permission into
	// something the subject can actually open.
	if len(service.lastGrant.Keys) != 1 || service.lastGrant.Keys[0].ScopeID != 1 {
		t.Fatalf("keys = %+v, want the one that was sent", service.lastGrant.Keys)
	}

	if service.lastGrant.VaultID != 9 || service.lastGrant.Subject.ID != 7 {
		t.Fatalf("target = vault %d subject %d, want 9/7", service.lastGrant.VaultID, service.lastGrant.Subject.ID)
	}
}

func TestErrorMapping(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		err    error
		status int
		code   string
		reason string
	}{
		"missing": {
			domain.ErrNotFound, http.StatusNotFound, response.CodeNotFound, response.ReasonNotFound,
		},
		"not a manager": {
			domain.ErrForbidden, http.StatusForbidden, response.CodeForbidden, response.ReasonForbidden,
		},
		"owner protected": {
			domain.ErrOwnerRequired, http.StatusForbidden, response.CodeForbidden,
			response.ReasonOwnerRequired,
		},
		"self target": {
			domain.ErrSelfTarget, http.StatusForbidden, response.CodeForbidden, response.ReasonSelfTarget,
		},
		"already member": {
			domain.ErrAlreadyMember, http.StatusConflict, response.CodeConflict,
			response.ReasonAlreadyMember,
		},
		"keys required": {
			domain.ErrKeysRequired, http.StatusUnprocessableEntity, response.CodeValidation,
			response.ReasonKeysRequired,
		},
		"group too big": {
			domain.ErrGroupMembers, http.StatusUnprocessableEntity, response.CodeValidation,
			response.ReasonGroupMembers,
		},
		"writer outside the group": {
			domain.ErrGroupKeyless, http.StatusUnprocessableEntity, response.CodeValidation,
			response.ReasonGroupKeyless,
		},
		"unsealed scopes": {
			domain.ErrGroupScopes, http.StatusUnprocessableEntity, response.CodeValidation,
			response.ReasonGroupScopes,
		},
		"rotation missing": {
			domain.ErrGroupRotation, http.StatusUnprocessableEntity, response.CodeValidation,
			response.ReasonGroupRotation,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, newTestRouter(t, &stubService{err: tc.err}), http.MethodDelete,
				"/api/v1/vaults/1/members/2", nil)

			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.status, rec.Body)
			}

			var body response.ErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if body.Error.Code != tc.code {
				t.Fatalf("code = %q, want %q", body.Error.Code, tc.code)
			}

			if got := body.Error.Details[response.ReasonKey]; got != tc.reason {
				t.Fatalf("reason = %q, want %q", got, tc.reason)
			}
		})
	}
}

func TestRemovalReportsPendingRotation(t *testing.T) {
	t.Parallel()

	service := &stubService{scopes: []int64{1, 4}}

	rec := doJSON(t, newTestRouter(t, service), http.MethodDelete, "/api/v1/vaults/1/members/2", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body handler.RemovalResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Revocation is immediate; rotation is what makes it retroactive. The caller has to
	// be told which scopes still need it rather than being left to assume it is done.
	if len(body.PendingRotation) != 2 {
		t.Fatalf("pending = %v, want two scopes", body.PendingRotation)
	}
}

func TestRemovalWithNothingPendingStillReturnsAList(t *testing.T) {
	t.Parallel()

	rec := doJSON(t, newTestRouter(t, &stubService{}), http.MethodDelete, "/api/v1/vaults/1/members/2", nil)

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if body["pending_rotation"] == nil {
		t.Fatalf("pending_rotation is null, want an empty list: %s", rec.Body)
	}
}

func TestLeaveReportsPendingRotation(t *testing.T) {
	t.Parallel()

	rec := doJSON(t, newTestRouter(t, &stubService{scopes: []int64{3}}), http.MethodPost,
		"/api/v1/vaults/1/leave", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body handler.RemovalResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// A leaver keeps whatever they already copied, so the scopes they held are stale for
	// everyone left behind — the same debt a removal reports.
	if len(body.PendingRotation) != 1 {
		t.Fatalf("pending = %v, want one scope", body.PendingRotation)
	}
}

// The owner cannot walk out of their own vault: the membership carries the vault, and a
// vault with no owner has nobody who can administer or delete it.
func TestLeaveRefusesTheOwner(t *testing.T) {
	t.Parallel()

	rec := doJSON(t, newTestRouter(t, &stubService{err: domain.ErrOwnerRequired}), http.MethodPost,
		"/api/v1/vaults/1/leave", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusForbidden, rec.Body)
	}
}

func TestGrantsQueryValidation(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{})

	for name, query := range map[string]string{
		"no scope type":  "?scope_ref_id=1",
		"bad scope type": "?scope_type=vault&scope_ref_id=1",
		"no ref":         "?scope_type=folder",
		"negative ref":   "?scope_type=folder&scope_ref_id=-1",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, router, http.MethodGet, "/api/v1/vaults/1/grants"+query, nil)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusBadRequest, rec.Body)
			}

			if got := reasonOf(t, rec); got != response.ReasonQueryInvalid {
				t.Fatalf("reason = %q, want %q", got, response.ReasonQueryInvalid)
			}
		})
	}
}

func TestProtectedRoutesNeedACaller(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	group := router.Group("/api/v1")
	handler.NewHandler(&stubService{}, ratelimit.Nop{}, zap.NewNop()).RegisterRoutes(group, group)

	rec := doJSON(t, router, http.MethodGet, "/api/v1/vaults/1/members", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnauthorized, rec.Body)
	}

	if got := reasonOf(t, rec); got != response.ReasonUnauthenticated {
		t.Fatalf("reason = %q, want %q", got, response.ReasonUnauthenticated)
	}
}
