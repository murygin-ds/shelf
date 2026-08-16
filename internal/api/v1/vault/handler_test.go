package vault_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"shelf/internal/api/middleware"
	"shelf/internal/api/response"
	handler "shelf/internal/api/v1/vault"
	"shelf/internal/ratelimit"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const testUserID int64 = 42

// stubService returns whatever the test asks it to. Every method is here because the
// handler's Service interface demands it; only the fields a test sets actually matter.
type stubService struct {
	err error

	vault      *vault.Vault
	summaries  []vault.Summary
	grants     []vault.KeyGrant
	scopes     []vault.ScopeStatus
	folders    []vault.Folder
	files      []vault.File
	folder     *vault.Folder
	file       *vault.File
	lastMove   vault.Move
	lastUpdate vault.ContentUpdate
	lastNew    vault.NewFolder
	lastCursor int64
	lastLimit  int
	rekeyPlan  *vault.RekeyPlan
	scope      *vault.KeyScope
	lastRekey  vault.NewRekey
	lastItems  []vault.RekeyItem
	lastGrants []vault.RekeyGrant
	events     []vault.AuditEvent
	backlinks  *vault.Backlinks
	graph      *vault.Graph
	revisions  []vault.Revision
	revision   *vault.Revision
	share      *vault.ShareLink
	shares     []vault.ShareLink
	public     *vault.PublicNote
	lastLinks  []int64
	lastShare  vault.NewShareLink
	lastToken  []byte
	lastLabel  *vault.Blob
	labelSet   bool
}

func (s *stubService) CreateVault(context.Context, int64, string, string, vault.Blob, vault.SealedKey) (*vault.Vault, error) {
	return s.vault, s.err
}
func (s *stubService) Vaults(context.Context, int64) ([]vault.Summary, error) {
	return s.summaries, s.err
}
func (s *stubService) Vault(context.Context, int64, int64) (*vault.Vault, error) {
	return s.vault, s.err
}
func (s *stubService) UpdateVault(context.Context, int64, int64, vault.Blob) error { return s.err }
func (s *stubService) SetLabel(_ context.Context, _, _ int64, label *vault.Blob) error {
	s.lastLabel = label
	s.labelSet = true

	return s.err
}
func (s *stubService) DeleteVault(context.Context, int64, int64) error { return s.err }
func (s *stubService) Keys(context.Context, int64, int64) ([]vault.KeyGrant, error) {
	return s.grants, s.err
}
func (s *stubService) Scopes(context.Context, int64, int64) ([]vault.ScopeStatus, error) {
	return s.scopes, s.err
}
func (s *stubService) Tree(context.Context, int64, int64) ([]vault.Folder, []vault.File, error) {
	return s.folders, s.files, s.err
}
func (s *stubService) Trash(context.Context, int64, int64) ([]vault.Folder, []vault.File, error) {
	return s.folders, s.files, s.err
}
func (s *stubService) Sync(_ context.Context, _, _, cursor int64, limit int) (*vault.Delta, error) {
	s.lastCursor, s.lastLimit = cursor, limit

	if s.err != nil {
		return nil, s.err
	}

	return &vault.Delta{Cursor: cursor + 1, Folders: s.folders, Files: s.files}, nil
}
func (s *stubService) CreateFolder(_ context.Context, _ int64, in vault.NewFolder) (*vault.Folder, error) {
	s.lastNew = in
	return s.folder, s.err
}
func (s *stubService) UpdateFolder(context.Context, int64, int64, vault.MetaUpdate) (*vault.Folder, error) {
	return s.folder, s.err
}
func (s *stubService) MoveFolder(_ context.Context, _, _ int64, in vault.Move) (*vault.Folder, error) {
	s.lastMove = in
	return s.folder, s.err
}
func (s *stubService) DeleteFolder(context.Context, int64, int64) error  { return s.err }
func (s *stubService) RestoreFolder(context.Context, int64, int64) error { return s.err }
func (s *stubService) PurgeFolder(context.Context, int64, int64) error   { return s.err }
func (s *stubService) CreateFile(context.Context, int64, vault.NewFile) (*vault.File, error) {
	return s.file, s.err
}
func (s *stubService) File(context.Context, int64, int64) (*vault.File, error) { return s.file, s.err }
func (s *stubService) Files(context.Context, int64, int64, []int64) ([]vault.File, error) {
	return s.files, s.err
}
func (s *stubService) UpdateFile(context.Context, int64, int64, vault.MetaUpdate) (*vault.File, error) {
	return s.file, s.err
}
func (s *stubService) UpdateContent(_ context.Context, _, _ int64, in vault.ContentUpdate) (*vault.File, error) {
	s.lastUpdate = in
	return s.file, s.err
}
func (s *stubService) MoveFile(context.Context, int64, int64, vault.Move) (*vault.File, error) {
	return s.file, s.err
}
func (s *stubService) DeleteFile(context.Context, int64, int64) error  { return s.err }
func (s *stubService) RestoreFile(context.Context, int64, int64) error { return s.err }
func (s *stubService) PurgeFile(context.Context, int64, int64) error   { return s.err }
func (s *stubService) StartRekey(_ context.Context, _ int64, in vault.NewRekey) (*vault.RekeyPlan, error) {
	s.lastRekey = in
	return s.rekeyPlan, s.err
}
func (s *stubService) StageRekeyItems(_ context.Context, _, _ int64, items []vault.RekeyItem) error {
	s.lastItems = items
	return s.err
}
func (s *stubService) CommitRekey(_ context.Context, _, _ int64, grants []vault.RekeyGrant) (*vault.KeyScope, error) {
	s.lastGrants = grants
	return s.scope, s.err
}
func (s *stubService) AbortRekey(context.Context, int64, int64) error { return s.err }
func (s *stubService) Audit(_ context.Context, _, _, _ int64, limit int) ([]vault.AuditEvent, error) {
	s.lastLimit = limit
	return s.events, s.err
}
func (s *stubService) SetLinks(_ context.Context, _, _ int64, to []int64) error {
	s.lastLinks = to
	return s.err
}
func (s *stubService) Backlinks(context.Context, int64, int64) (*vault.Backlinks, error) {
	return s.backlinks, s.err
}
func (s *stubService) Graph(context.Context, int64, int64) (*vault.Graph, error) {
	return s.graph, s.err
}
func (s *stubService) Revisions(_ context.Context, _, _ int64, limit int) ([]vault.Revision, error) {
	s.lastLimit = limit
	return s.revisions, s.err
}
func (s *stubService) Revision(context.Context, int64, int64) (*vault.Revision, error) {
	return s.revision, s.err
}
func (s *stubService) CreateShareLink(_ context.Context, _ int64, in vault.NewShareLink) (*vault.ShareLink, error) {
	s.lastShare = in
	return s.share, s.err
}
func (s *stubService) ShareLinks(context.Context, int64, int64) ([]vault.ShareLink, error) {
	return s.shares, s.err
}
func (s *stubService) RevokeShareLink(context.Context, int64, int64) error { return s.err }
func (s *stubService) PublicNote(_ context.Context, tokenHash []byte) (*vault.PublicNote, error) {
	s.lastToken = tokenHash
	return s.public, s.err
}

// newTestRouter mounts the handler behind a middleware that stands in for the real token
// check, so the routes see an authenticated caller without issuing a JWT.
func newTestRouter(t *testing.T, service handler.Service) *gin.Engine {
	t.Helper()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	group := router.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextUserID, testUserID)
		c.Next()
	})

	handler.NewHandler(service, ratelimit.Nop{}, zap.NewNop()).RegisterRoutes(group)

	return router
}

func doJSON(t *testing.T, router *gin.Engine, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
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

	for name, value := range headers {
		req.Header.Set(name, value)
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	return rec
}

func validFolderBody() map[string]any {
	blob := func(n int, fill byte) []byte { return bytes.Repeat([]byte{fill}, n) }

	return map[string]any{
		"client_id":    "2f1c8b7a-5d3e-4a1b-9c2d-8e7f6a5b4c3d",
		"meta":         blob(64, 1),
		"meta_nonce":   blob(12, 2),
		"key_scope_id": 7,
		"key_version":  1,
	}
}

func validContentBody() map[string]any {
	blob := func(n int, fill byte) []byte { return bytes.Repeat([]byte{fill}, n) }

	// The key is part of the write now: a body sealed under a version the row has moved
	// past has to be refused rather than relabelled.
	return map[string]any{
		"content":       blob(4112, 3),
		"content_nonce": blob(12, 4),
		"key_scope_id":  3,
		"key_version":   1,
	}
}

// TestErrorMapping pins every domain error to the status the client branches on. The
// conflict codes in particular drive real UI: one opens a merge dialog, the other tells
// the user their client sealed the payload with the wrong key.
func TestErrorMapping(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		err        error
		wantStatus int
		wantCode   string
	}{
		"missing": {vault.ErrNotFound, http.StatusNotFound, response.CodeNotFound},
		"forbidden": {
			vault.ErrForbidden, http.StatusForbidden, response.CodeForbidden,
		},
		"stale content": {
			vault.ErrVersionConflict, http.StatusConflict, response.CodeConflict,
		},
		"foreign key scope": {
			vault.ErrScopeMismatch, http.StatusConflict, response.CodeConflict,
		},
		"cycle": {
			vault.ErrCycle, http.StatusUnprocessableEntity, response.CodeValidation,
		},
		"too deep": {
			vault.ErrDepthExceeded, http.StatusUnprocessableEntity, response.CodeValidation,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			router := newTestRouter(t, &stubService{err: tc.err})

			rec := doJSON(t, router, http.MethodPost, "/api/v1/vaults/1/folders", validFolderBody(), nil)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.wantStatus, rec.Body)
			}

			var body response.ErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal %s: %v", rec.Body, err)
			}

			if body.Error.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", body.Error.Code, tc.wantCode)
			}
		})
	}
}

func TestUnmappedErrorStaysOpaque(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{err: context.DeadlineExceeded})

	rec := doJSON(t, router, http.MethodPost, "/api/v1/vaults/1/folders", validFolderBody(), nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}

	// The cause belongs in the logs, never in the response.
	if bytes.Contains(rec.Body.Bytes(), []byte("deadline")) {
		t.Fatalf("body leaks the cause: %s", rec.Body)
	}
}

func TestContentWriteRequiresIfMatch(t *testing.T) {
	t.Parallel()

	service := &stubService{file: &vault.File{ID: 1, ContentSeq: 8}}
	router := newTestRouter(t, service)

	cases := map[string]struct {
		header string
		want   int
	}{
		"absent":       {"", http.StatusPreconditionRequired},
		"not a number": {"latest", http.StatusBadRequest},
		"zero":         {"0", http.StatusBadRequest},
		"valid":        {"7", http.StatusOK},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			headers := map[string]string{}
			if tc.header != "" {
				headers["If-Match"] = tc.header
			}

			rec := doJSON(t, router, http.MethodPut, "/api/v1/files/1/content", validContentBody(), headers)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.want, rec.Body)
			}
		})
	}
}

func TestContentWritePassesTheExpectedSequence(t *testing.T) {
	t.Parallel()

	service := &stubService{file: &vault.File{ID: 1, ContentSeq: 8}}
	router := newTestRouter(t, service)

	rec := doJSON(t, router, http.MethodPut, "/api/v1/files/1/content",
		validContentBody(), map[string]string{"If-Match": "7"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	if service.lastUpdate.ExpectedSeq != 7 {
		t.Fatalf("ExpectedSeq = %d, want 7", service.lastUpdate.ExpectedSeq)
	}

	var body handler.ContentResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if body.ContentSeq != 8 {
		t.Fatalf("content_seq = %d, want 8", body.ContentSeq)
	}
}

func TestInvalidIDsAreNotFound(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{})

	// A malformed id must not reach the service, and must not be told apart from an id
	// that simply does not exist.
	for _, path := range []string{"/api/v1/vaults/abc", "/api/v1/vaults/0", "/api/v1/vaults/-3"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, router, http.MethodGet, path, nil, nil)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
			}
		})
	}
}

func TestCreateFolderValidation(t *testing.T) {
	t.Parallel()

	invalid := map[string]func(map[string]any){
		"no meta":                 func(b map[string]any) { delete(b, "meta") },
		"short nonce":             func(b map[string]any) { b["meta_nonce"] = bytes.Repeat([]byte{1}, 4) },
		"no key scope":            func(b map[string]any) { delete(b, "key_scope_id") },
		"zero key version":        func(b map[string]any) { b["key_version"] = 0 },
		"parent zero":             func(b map[string]any) { b["parent_id"] = 0 },
		"no client id":            func(b map[string]any) { delete(b, "client_id") },
		"client id is not a uuid": func(b map[string]any) { b["client_id"] = "folder-1" },
	}

	for name, corrupt := range invalid {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			body := validFolderBody()
			corrupt(body)

			rec := doJSON(t, newTestRouter(t, &stubService{}), http.MethodPost, "/api/v1/vaults/1/folders", body, nil)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
			}
		})
	}
}

// An empty body is how a label is removed, and half a sealed box is refused: stored
// without its nonce it would be bytes nobody — including its author — can ever open.
func TestSetLabelClearsAndRefusesHalfABox(t *testing.T) {
	t.Parallel()

	sealed := bytes.Repeat([]byte{9}, 96)
	nonce := bytes.Repeat([]byte{3}, 12)

	t.Run("writes the pair", func(t *testing.T) {
		t.Parallel()

		service := &stubService{}
		rec := doJSON(t, newTestRouter(t, service), http.MethodPut, "/api/v1/vaults/1/label",
			map[string]any{"label": sealed, "label_nonce": nonce}, nil)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body)
		}

		if service.lastLabel == nil || !bytes.Equal(service.lastLabel.Ciphertext, sealed) {
			t.Fatalf("label = %v, want the sealed box through untouched", service.lastLabel)
		}
	})

	t.Run("empty clears", func(t *testing.T) {
		t.Parallel()

		service := &stubService{}
		rec := doJSON(t, newTestRouter(t, service), http.MethodPut, "/api/v1/vaults/1/label",
			map[string]any{}, nil)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body)
		}

		if !service.labelSet || service.lastLabel != nil {
			t.Fatalf("label = %v, want a clear", service.lastLabel)
		}
	})

	for name, body := range map[string]map[string]any{
		"no nonce":  {"label": sealed},
		"no cipher": {"label_nonce": nonce},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			service := &stubService{}
			rec := doJSON(t, newTestRouter(t, service), http.MethodPut, "/api/v1/vaults/1/label", body, nil)

			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
			}

			if service.labelSet {
				t.Fatal("the service was called with half a sealed box")
			}
		})
	}
}

func TestCreateFolderCarriesTheDeclaredScope(t *testing.T) {
	t.Parallel()

	service := &stubService{folder: &vault.Folder{ID: 5}}
	router := newTestRouter(t, service)

	rec := doJSON(t, router, http.MethodPost, "/api/v1/vaults/9/folders", validFolderBody(), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusCreated, rec.Body)
	}

	// The scope the client sealed with has to reach the service intact: it is the only
	// thing standing between a typo and a row nobody can ever decrypt.
	if service.lastNew.KeyScopeID != 7 || service.lastNew.KeyVersion != 1 {
		t.Fatalf("scope = %d/v%d, want 7/v1", service.lastNew.KeyScopeID, service.lastNew.KeyVersion)
	}

	if service.lastNew.VaultID != 9 {
		t.Fatalf("VaultID = %d, want 9", service.lastNew.VaultID)
	}
}

func TestBulkFilesIsBounded(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{})

	ids := make([]int64, 201)
	for i := range ids {
		ids[i] = int64(i + 1)
	}

	rec := doJSON(t, router, http.MethodPost, "/api/v1/vaults/1/files/bulk", map[string]any{"ids": ids}, nil)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnprocessableEntity)
	}

	empty := doJSON(t, router, http.MethodPost, "/api/v1/vaults/1/files/bulk", map[string]any{"ids": []int64{}}, nil)
	if empty.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", empty.Code, http.StatusUnprocessableEntity)
	}
}

func TestTreeOmitsBodies(t *testing.T) {
	t.Parallel()

	service := &stubService{
		folders: []vault.Folder{{ID: 1, Access: vault.Access{Permission: vault.PermOwn}}},
		files: []vault.File{{
			ID:      2,
			Meta:    vault.Blob{Ciphertext: []byte("meta"), Nonce: []byte("nonce")},
			Content: vault.Blob{Ciphertext: []byte("body"), Nonce: []byte("nonce")},
			Access:  vault.Access{Permission: vault.PermView},
		}},
	}

	rec := doJSON(t, newTestRouter(t, service), http.MethodGet, "/api/v1/vaults/1/tree", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body handler.TreeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if len(body.Files) != 1 {
		t.Fatalf("files = %d, want 1", len(body.Files))
	}

	// The tree is the cheap tier of the sync: shipping bodies here would turn a first
	// sync of a large vault into one enormous response.
	if body.Files[0].Content != nil {
		t.Fatalf("tree carried a note body: %s", rec.Body)
	}

	if body.Files[0].Meta == nil {
		t.Fatal("tree dropped the metadata it exists to deliver")
	}
}

func TestSyncCursorAndLimit(t *testing.T) {
	t.Parallel()

	t.Run("defaults when absent", func(t *testing.T) {
		t.Parallel()

		service := &stubService{}
		rec := doJSON(t, newTestRouter(t, service), http.MethodGet, "/api/v1/vaults/1/sync", nil, nil)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
		}

		if service.lastCursor != 0 || service.lastLimit != vault.DefaultSyncLimit {
			t.Fatalf("cursor/limit = %d/%d, want 0/%d", service.lastCursor, service.lastLimit, vault.DefaultSyncLimit)
		}
	})

	t.Run("passed through", func(t *testing.T) {
		t.Parallel()

		service := &stubService{}
		rec := doJSON(t, newTestRouter(t, service), http.MethodGet,
			"/api/v1/vaults/1/sync?cursor=4821&limit=50", nil, nil)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}

		if service.lastCursor != 4821 || service.lastLimit != 50 {
			t.Fatalf("cursor/limit = %d/%d, want 4821/50", service.lastCursor, service.lastLimit)
		}
	})

	// A cursor the server cannot parse must not silently become "from the beginning":
	// the client would take a full vault for a delta and never notice.
	for name, query := range map[string]string{
		"not a number": "?cursor=abc",
		"negative":     "?cursor=-1",
		"bad limit":    "?limit=zero",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, newTestRouter(t, &stubService{}), http.MethodGet,
				"/api/v1/vaults/1/sync"+query, nil, nil)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusBadRequest, rec.Body)
			}
		})
	}
}

func TestSyncOmitsBodies(t *testing.T) {
	t.Parallel()

	service := &stubService{
		files: []vault.File{{
			ID:      2,
			Meta:    vault.Blob{Ciphertext: []byte("meta"), Nonce: []byte("nonce")},
			Content: vault.Blob{Ciphertext: []byte("body"), Nonce: []byte("nonce")},
		}},
	}

	rec := doJSON(t, newTestRouter(t, service), http.MethodGet, "/api/v1/vaults/1/sync", nil, nil)

	var body handler.SyncResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	// The delta is the cheap tier: bodies are fetched in bulk afterwards, so a first sync
	// of a large vault is not one enormous response.
	if len(body.Files) != 1 || body.Files[0].Content != nil {
		t.Fatalf("delta carried a note body: %s", rec.Body)
	}

	if body.Purged.Folders == nil || body.Purged.Files == nil {
		t.Fatalf("purged lists must be present, got %s", rec.Body)
	}
}

func TestMissingCallerIsUnauthorized(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)

	// A route mounted outside the auth middleware must say so rather than answer an
	// empty 200, which would be the hardest possible version of that bug to find.
	router := gin.New()
	handler.NewHandler(&stubService{}, ratelimit.Nop{}, zap.NewNop()).RegisterRoutes(router.Group("/api/v1"))

	rec := doJSON(t, router, http.MethodGet, "/api/v1/vaults", nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnauthorized, rec.Body)
	}
}

func sealedKeyBody() map[string]any {
	blob := func(n int, fill byte) []byte { return bytes.Repeat([]byte{fill}, n) }

	return map[string]any{
		"subject_type": "user",
		"subject_id":   7,
		"wrapped_key":  blob(113, 1),
		"nonce":        blob(12, 2),
	}
}

// TestRekeyCommitNeedsAKey pins the rule the whole job exists to uphold: a new key that
// reaches nobody would make every row it touches unreadable.
func TestRekeyCommitNeedsAKey(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{scope: &vault.KeyScope{ID: 4, KeyVersion: 1}})

	rec := doJSON(t, router, http.MethodPost, "/api/v1/rekeys/1/commit",
		map[string]any{"key_grants": []any{}}, nil)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
	}
}

func TestRekeyCommitPassesTheGrantsThrough(t *testing.T) {
	t.Parallel()

	service := &stubService{scope: &vault.KeyScope{ID: 4, ClientID: "scope-uuid", KeyVersion: 2}}

	rec := doJSON(t, newTestRouter(t, service), http.MethodPost, "/api/v1/rekeys/1/commit",
		map[string]any{"key_grants": []any{sealedKeyBody()}}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	if len(service.lastGrants) != 1 || service.lastGrants[0].Subject.ID != 7 {
		t.Fatalf("grants = %+v, want the one that was sent", service.lastGrants)
	}

	var body handler.RekeyResultResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// The client needs both to seal anything else against this scope afterwards.
	if body.ScopeClientID == "" || body.KeyVersion != 2 {
		t.Fatalf("result = %+v, want the scope identity and its new version", body)
	}
}

func TestStaleRekeyIsAConflict(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{err: vault.ErrRekeyStale})

	rec := doJSON(t, router, http.MethodPost, "/api/v1/rekeys/1/commit",
		map[string]any{"key_grants": []any{sealedKeyBody()}}, nil)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusConflict, rec.Body)
	}
}

func TestStagingBatchIsBounded(t *testing.T) {
	t.Parallel()

	blob := func(n int, fill byte) []byte { return bytes.Repeat([]byte{fill}, n) }

	item := map[string]any{
		"entity_type": "folder",
		"entity_id":   1,
		"meta":        blob(64, 1),
		"meta_nonce":  blob(12, 2),
	}

	items := make([]any, 201)
	for i := range items {
		items[i] = item
	}

	router := newTestRouter(t, &stubService{})

	tooMany := doJSON(t, router, http.MethodPut, "/api/v1/rekeys/1/items", map[string]any{"items": items}, nil)
	if tooMany.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", tooMany.Code, http.StatusUnprocessableEntity)
	}

	empty := doJSON(t, router, http.MethodPut, "/api/v1/rekeys/1/items", map[string]any{"items": []any{}}, nil)
	if empty.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", empty.Code, http.StatusUnprocessableEntity)
	}
}

// TestAuditIsForManagersOnly pins who may read the history: it records who works with whom,
// which is more than the tree itself gives away.
func TestAuditIsForManagersOnly(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, &stubService{err: vault.ErrForbidden})

	rec := doJSON(t, router, http.MethodGet, "/api/v1/vaults/1/audit", nil, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusForbidden, rec.Body)
	}
}

func TestAuditPagesFromTheOldestEntrySeen(t *testing.T) {
	t.Parallel()

	service := &stubService{events: []vault.AuditEvent{
		{ID: 9, Action: vault.AuditKeyRotated, Detail: json.RawMessage(`{"to_version":2}`)},
		{ID: 4, Action: vault.AuditMemberRemove},
	}}

	rec := doJSON(t, newTestRouter(t, service), http.MethodGet, "/api/v1/vaults/1/audit?limit=2", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body handler.AuditResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if service.lastLimit != 2 {
		t.Fatalf("limit = %d, want 2", service.lastLimit)
	}

	// The cursor is the oldest entry of the page, not the newest: the next page continues
	// downwards, and a concurrent write at the top must not shift it.
	if body.Cursor != 4 {
		t.Fatalf("cursor = %d, want 4", body.Cursor)
	}
}
