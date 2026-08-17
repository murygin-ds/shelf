package realtime_test

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/realtime"
	"shelf/internal/vault"

	"github.com/coder/websocket"
)

const noteID = 88

// room sets up one note with three people on it: two editors and a reader.
func room(t *testing.T, cfg config.Realtime) (*realtime.Hub, string, *workspace) {
	t.Helper()

	ws := newWorkspace()
	ws.vaults[12] = true
	ws.allow(7, noteID, vault.PermEdit)
	ws.allow(9, noteID, vault.PermEdit)
	ws.allow(5, noteID, vault.PermView)

	parser := tokens{claims: map[string]*auth.Claims{
		"first":  claimsFor(7, time.Hour),
		"second": claimsFor(9, time.Hour),
		"reader": claimsFor(5, time.Hour),
	}}

	hub, url := serveWith(t, parser, cfg, ws)

	return hub, url, ws
}

// joins connects and authenticates, returning a socket ready to open a note.
func joins(t *testing.T, url, token string) *websocket.Conn {
	t.Helper()

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": token})

	if frame := read(t, ws); frame["type"] != realtime.FrameReady {
		t.Fatalf("handshake answered %v, want ready", frame["type"])
	}

	return ws
}

func b64(text string) string {
	return base64.StdEncoding.EncodeToString([]byte(text))
}

// waitFor reads until a frame of the wanted type arrives, so a presence frame in between
// does not derail a test waiting for something else.
func waitFor(t *testing.T, ws *websocket.Conn, want string) map[string]any {
	t.Helper()

	for range 8 {
		frame := read(t, ws)
		if frame["type"] == want {
			return frame
		}
	}

	t.Fatalf("no %s frame arrived", want)

	return nil
}

// silence asserts nothing else arrives, which is how "was not relayed" is checked.
func silence(t *testing.T, ws *websocket.Conn) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if _, payload, err := ws.Read(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected silence, got %s (%v)", payload, err)
	}
}

// seedNote opens the note on a socket and seeds the document, leaving it ready to edit.
func seedNote(t *testing.T, ws *websocket.Conn) {
	t.Helper()

	write(t, ws, map[string]any{"type": "open", "file_id": noteID})

	if frame := waitFor(t, ws, realtime.FrameAbsent); frame["file_id"] != float64(noteID) {
		t.Fatalf("absent names note %v", frame["file_id"])
	}

	write(t, ws, map[string]any{
		"type": "seed", "file_id": noteID, "content_seq": 1,
		"payload": b64("state"), "nonce": b64("nonce1234567"),
		"key_scope_id": 3, "key_version": 1,
	})

	waitFor(t, ws, realtime.FrameDoc)
}

// A note nobody has edited has no document, and whoever can write starts one.
func TestOpeningAnUnseededNote(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	ws := joins(t, url, "first")
	seedNote(t, ws)
}

// The loser of a seeding race is handed the winner's document rather than an error: two
// independently seeded copies name the same characters differently, and merging them
// writes the text twice.
func TestTheSecondSeedAdoptsTheFirst(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	first := joins(t, url, "first")
	seedNote(t, first)

	second := joins(t, url, "second")
	write(t, second, map[string]any{"type": "open", "file_id": noteID})

	frame := waitFor(t, second, realtime.FrameDoc)
	if frame["epoch"] != float64(1) {
		t.Fatalf("the second client got epoch %v, want the first one's", frame["epoch"])
	}
}

// The whole point: what one editor writes reaches the other.
func TestAnUpdateReachesTheRestOfTheRoom(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	first := joins(t, url, "first")
	seedNote(t, first)

	second := joins(t, url, "second")
	write(t, second, map[string]any{"type": "open", "file_id": noteID})
	waitFor(t, second, realtime.FrameDoc)

	write(t, first, map[string]any{
		"type": "update", "file_id": noteID, "epoch": 1,
		"payload": b64("typed"), "nonce": b64("nonce1234567"),
		"key_scope_id": 3, "key_version": 1,
	})

	relayed := waitFor(t, second, realtime.FrameUpdate)
	if relayed["payload"] != b64("typed") {
		t.Fatalf("relayed payload is %v", relayed["payload"])
	}

	if relayed["user_id"] != float64(7) {
		t.Fatalf("relayed update is attributed to %v, want the author", relayed["user_id"])
	}

	if ack := waitFor(t, first, realtime.FrameAck); ack["seq"] != float64(1) {
		t.Fatalf("the author was acknowledged at %v, want 1", ack["seq"])
	}
}

// View means read. A reader's update is refused and, more importantly, never relayed: the
// others must not see text the server would not store.
func TestAReadersUpdateIsRefusedAndNotRelayed(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	editor := joins(t, url, "first")
	seedNote(t, editor)

	reader := joins(t, url, "reader")
	write(t, reader, map[string]any{"type": "open", "file_id": noteID})
	waitFor(t, reader, realtime.FrameDoc)

	// The editor has heard the reader join; anything after this is the update or nothing.
	waitFor(t, editor, realtime.FramePresence)

	write(t, reader, map[string]any{
		"type": "update", "file_id": noteID, "epoch": 1,
		"payload": b64("forged"), "nonce": b64("nonce1234567"),
		"key_scope_id": 3, "key_version": 1,
	})

	if frame := waitFor(t, reader, realtime.FrameError); frame["code"] != "forbidden" {
		t.Fatalf("a reader's update answered %v, want forbidden", frame["code"])
	}

	silence(t, editor)
}

// A reader has to be able to show their own caret, or "who is here" is a lie.
func TestAReadersAwarenessIsRelayed(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	editor := joins(t, url, "first")
	seedNote(t, editor)

	reader := joins(t, url, "reader")
	write(t, reader, map[string]any{"type": "open", "file_id": noteID})
	waitFor(t, reader, realtime.FrameDoc)
	waitFor(t, editor, realtime.FramePresence)

	write(t, reader, map[string]any{
		"type": "awareness", "file_id": noteID,
		"payload": b64("caret"), "nonce": b64("nonce1234567"),
	})

	frame := waitFor(t, editor, realtime.FrameAwareness)
	if frame["payload"] != b64("caret") {
		t.Fatalf("relayed awareness carries %v", frame["payload"])
	}

	// The identity is the server's own. A client cannot claim to be somebody else by
	// writing their name into a payload only the readers can open.
	if frame["user_id"] != float64(5) {
		t.Fatalf("awareness is attributed to %v, want the sender", frame["user_id"])
	}
}

// The presence list is what the header shows, and the committer flag on it decides who
// writes the body back.
func TestPresenceNamesTheRoomAndItsCommitter(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	first := joins(t, url, "first")
	seedNote(t, first)

	second := joins(t, url, "second")
	write(t, second, map[string]any{"type": "open", "file_id": noteID})

	frame := waitFor(t, second, realtime.FramePresence)

	peers, ok := frame["peers"].([]any)
	if !ok || len(peers) != 2 {
		t.Fatalf("presence lists %v, want two people", frame["peers"])
	}

	committers := 0

	for _, entry := range peers {
		peer, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("peer entry is %T", entry)
		}

		if peer["committer"] == true {
			committers++

			if peer["user_id"] != float64(7) {
				t.Errorf("the committer is %v, want the longest standing editor", peer["user_id"])
			}
		}

		if peer["display_name"] == "" {
			t.Errorf("peer %v has no name to show", peer["user_id"])
		}
	}

	if committers != 1 {
		t.Fatalf("%d peers claim to be the committer, want exactly 1", committers)
	}
}

// When the committer leaves, somebody else has to take the job — otherwise the body stops
// being written back and the note silently stops appearing in search.
func TestTheCommitterIsReplacedWhenItLeaves(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	first := joins(t, url, "first")
	seedNote(t, first)

	second := joins(t, url, "second")
	write(t, second, map[string]any{"type": "open", "file_id": noteID})
	waitFor(t, second, realtime.FramePresence)

	write(t, first, map[string]any{"type": "close", "file_id": noteID})

	frame := waitFor(t, second, realtime.FramePresence)

	peers, ok := frame["peers"].([]any)
	if !ok || len(peers) != 1 {
		t.Fatalf("presence lists %v, want one person", frame["peers"])
	}

	peer, ok := peers[0].(map[string]any)
	if !ok {
		t.Fatalf("peer entry is %T", peers[0])
	}

	if peer["user_id"] != float64(9) || peer["committer"] != true {
		t.Fatalf("after the committer left, presence says %v", peer)
	}
}

// One person with two tabs is one entry in the list and one committer.
//
// The list answers "who is here", so a second tab is not a second person — but committing
// is a property of the socket, and telling both tabs they hold the job means two writers
// racing the same If-Match, with one of them collecting a conflict banner for nothing.
func TestTwoTabsOfOnePersonProduceOneCommitter(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	first := joins(t, url, "first")
	seedNote(t, first)

	second := joins(t, url, "first")
	write(t, second, map[string]any{"type": "open", "file_id": noteID})

	frames := []map[string]any{
		waitFor(t, first, realtime.FramePresence),
		waitFor(t, second, realtime.FramePresence),
	}

	committing := 0

	for _, frame := range frames {
		peers, ok := frame["peers"].([]any)
		if !ok || len(peers) != 1 {
			t.Fatalf("presence lists %v, want one person for two tabs of one account", frame["peers"])
		}

		if frame["committing"] == true {
			committing++
		}
	}

	if committing != 1 {
		t.Fatalf("%d of the two tabs believe they commit, want exactly 1", committing)
	}
}

// An update against a replaced document cannot be merged into what is stored, so the
// client is told to start again rather than handed an error it would retry.
func TestAnUpdateForAReplacedDocumentAsksForAReseed(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	ws := joins(t, url, "first")
	seedNote(t, ws)

	write(t, ws, map[string]any{
		"type": "update", "file_id": noteID, "epoch": 7,
		"payload": b64("stale"), "nonce": b64("nonce1234567"),
		"key_scope_id": 3, "key_version": 1,
	})

	if frame := waitFor(t, ws, realtime.FrameReseed); frame["file_id"] != float64(noteID) {
		t.Fatalf("reseed names %v", frame["file_id"])
	}
}

// A writer outside the room would produce an update nobody present ever hears about.
func TestWritingBeforeOpeningIsRefused(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	ws := joins(t, url, "first")

	write(t, ws, map[string]any{
		"type": "update", "file_id": noteID, "epoch": 1,
		"payload": b64("typed"), "nonce": b64("nonce1234567"),
		"key_scope_id": 3, "key_version": 1,
	})

	if frame := waitFor(t, ws, realtime.FrameError); frame["code"] != "bad_request" {
		t.Fatalf("writing before opening answered %v", frame["code"])
	}
}

// A note the caller cannot see answers not_found, so an id does not become an oracle.
func TestOpeningAnInvisibleNote(t *testing.T) {
	t.Parallel()

	_, url, _ := room(t, testConfig())

	ws := joins(t, url, "first")
	write(t, ws, map[string]any{"type": "open", "file_id": 4242})

	if frame := waitFor(t, ws, realtime.FrameError); frame["code"] != "not_found" {
		t.Fatalf("an invisible note answered %v, want not_found", frame["code"])
	}
}

// The throttle is what a stuck loop meets. Typing is batched client-side into about four
// frames a second and never comes near it.
func TestUpdateFloodIsThrottled(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.UpdateRate = config.Rule{Limit: 3, Window: time.Minute}

	_, url, _ := room(t, cfg)

	ws := joins(t, url, "first")
	seedNote(t, ws)

	for range cfg.UpdateRate.Limit {
		write(t, ws, map[string]any{
			"type": "update", "file_id": noteID, "epoch": 1,
			"payload": b64("typed"), "nonce": b64("nonce1234567"),
			"key_scope_id": 3, "key_version": 1,
		})

		waitFor(t, ws, realtime.FrameAck)
	}

	write(t, ws, map[string]any{
		"type": "update", "file_id": noteID, "epoch": 1,
		"payload": b64("once more"), "nonce": b64("nonce1234567"),
		"key_scope_id": 3, "key_version": 1,
	})

	if frame := waitFor(t, ws, realtime.FrameError); frame["code"] != "too_many_requests" {
		t.Fatalf("the flood answered %v, want too_many_requests", frame["code"])
	}
}

// A body written around the document — an offline write replayed, or a re-key — replaces
// what the room holds, and everyone in it has to be told before they write again.
func TestInvalidationReachesTheRoom(t *testing.T) {
	t.Parallel()

	hub, url, _ := room(t, testConfig())

	ws := joins(t, url, "first")
	seedNote(t, ws)

	hub.NoteInvalidated(noteID)

	if frame := waitFor(t, ws, realtime.FrameReseed); frame["file_id"] != float64(noteID) {
		t.Fatalf("reseed names %v", frame["file_id"])
	}
}
