// Package realtime carries the live editing session. It relays sealed document updates
// between the tabs that hold the key, and announces that a vault has moved so a client
// learns of a change without waiting for its next poll.
//
// Nothing here reads a note. Payloads arrive sealed and leave sealed: the server decides
// who may speak, how often and about which note, never what was said.
package realtime

import "shelf/internal/vault"

// Frame types spoken over the socket.
const (
	// Client to server.
	FrameAuth      = "auth"
	FrameSubscribe = "subscribe"
	FrameOpen      = "open"
	FrameSeed      = "seed"
	FrameUpdate    = "update"
	FrameAwareness = "awareness"
	FrameClose     = "close"

	// Server to client.
	FrameReady      = "ready"
	FrameSubscribed = "subscribed"
	FrameChanged    = "changed"
	FrameDoc        = "doc"
	FrameAbsent     = "absent"
	FramePresence   = "presence"
	FrameAck        = "ack"
	FrameReseed     = "reseed"
	FrameError      = "error"
)

// Error codes particular to the socket. The rest are the ones in api/response.
const (
	CodeTokenExpired    = "token_expired"
	CodeCompactRequired = "compact_required"
)

// Close codes outside the registered range, so a client can tell a refused session from a
// network failure. 4401 mirrors HTTP 401 by construction, which is what makes it readable.
const (
	CloseUnauthorized = 4401
)

// inbound is every frame a client may send.
//
// One struct rather than a decode per type: the frames share most of their fields, and a
// second pass over the bytes to pick a type buys nothing at this size.
type inbound struct {
	Type    string `json:"type"`
	Token   string `json:"token,omitempty"`
	VaultID int64  `json:"vault_id,omitempty"`
	FileID  int64  `json:"file_id,omitempty"`
	Epoch   int32  `json:"epoch,omitempty"`
	// Since is the last sequence the client already holds, so a reconnect asks for the
	// tail rather than the whole log.
	Since int64 `json:"since,omitempty"`
	// ContentSeq is the body version a seed was built from.
	ContentSeq int64  `json:"content_seq,omitempty"`
	Payload    []byte `json:"payload,omitempty"`
	Nonce      []byte `json:"nonce,omitempty"`
	KeyScopeID int64  `json:"key_scope_id,omitempty"`
	KeyVersion int32  `json:"key_version,omitempty"`
	Signature  []byte `json:"signature,omitempty"`
}

// update is one stored batch on its way back out.
type update struct {
	Seq       int64  `json:"seq"`
	Payload   []byte `json:"payload"`
	Nonce     []byte `json:"nonce"`
	AuthorID  *int64 `json:"author_id,omitempty"`
	Signature []byte `json:"signature,omitempty"`
}

// peer is one person in a room. Everything here is something the server already knows —
// membership, display names — so publishing it teaches it nothing new. Where the carets
// are is a different matter and travels sealed.
type peer struct {
	UserID      int64  `json:"user_id"`
	Login       string `json:"login"`
	DisplayName string `json:"display_name"`
	Permission  string `json:"permission"`
	// Committer names the one connection that writes the body back. The server picks it
	// because it already knows the room and its join order; an election among clients
	// would only add a way for two of them to both believe they won.
	Committer bool `json:"committer,omitempty"`
}

// outbound is built through the constructors below, so a frame cannot go out half-filled.
type outbound struct {
	Type      string `json:"type"`
	UserID    int64  `json:"user_id,omitempty"`
	VaultID   int64  `json:"vault_id,omitempty"`
	ChangeSeq int64  `json:"change_seq,omitempty"`
	FileID    int64  `json:"file_id,omitempty"`
	Epoch     int32  `json:"epoch,omitempty"`

	// The document handshake.
	CommittedSeq int64    `json:"committed_seq,omitempty"`
	LastSeq      int64    `json:"last_seq,omitempty"`
	SnapshotSeq  int64    `json:"snapshot_seq,omitempty"`
	Snapshot     []byte   `json:"snapshot,omitempty"`
	Nonce        []byte   `json:"nonce,omitempty"`
	KeyScopeID   int64    `json:"key_scope_id,omitempty"`
	KeyVersion   int32    `json:"key_version,omitempty"`
	Updates      []update `json:"updates,omitempty"`

	// Relayed traffic.
	Seq       int64  `json:"seq,omitempty"`
	Payload   []byte `json:"payload,omitempty"`
	Signature []byte `json:"signature,omitempty"`
	Peers     []peer `json:"peers,omitempty"`
	// Committing tells this connection, and no other, that it is the one writing the body
	// back. It is per socket rather than per person: two tabs of one account are one entry
	// in Peers but only one of them commits.
	Committing bool `json:"committing,omitempty"`

	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func ready(userID int64) outbound {
	return outbound{Type: FrameReady, UserID: userID}
}

func subscribed(vaultID int64) outbound {
	return outbound{Type: FrameSubscribed, VaultID: vaultID}
}

func changed(vaultID, changeSeq int64) outbound {
	return outbound{Type: FrameChanged, VaultID: vaultID, ChangeSeq: changeSeq}
}

// document is the whole state a joining client needs: the snapshot it starts from and
// every update written since.
func document(doc *vault.CRDTDoc, tail []vault.CRDTUpdate) outbound {
	frame := outbound{
		Type:         FrameDoc,
		FileID:       doc.FileID,
		Epoch:        doc.Epoch,
		CommittedSeq: doc.CommittedSeq,
		LastSeq:      doc.LastSeq,
		SnapshotSeq:  doc.SnapshotSeq,
		KeyScopeID:   doc.KeyScopeID,
		KeyVersion:   doc.KeyVersion,
		Updates:      make([]update, 0, len(tail)),
	}

	if doc.Snapshot != nil {
		frame.Snapshot = doc.Snapshot.Ciphertext
		frame.Nonce = doc.Snapshot.Nonce
	}

	for _, stored := range tail {
		frame.Updates = append(frame.Updates, update{
			Seq:       stored.Seq,
			Payload:   stored.Payload.Ciphertext,
			Nonce:     stored.Payload.Nonce,
			AuthorID:  stored.AuthorID,
			Signature: stored.Signature,
		})
	}

	return frame
}

// absent says the note has no live document to hand over, so whoever may write should seed
// one. The epoch travels with it: a seed is sealed under the epoch it will be stored at, and
// a note whose document was invalidated keeps the epoch it had reached.
func absent(fileID int64, epoch int32) outbound {
	return outbound{Type: FrameAbsent, FileID: fileID, Epoch: epoch}
}

// relayed is somebody else's update on its way to the rest of the room.
func relayed(fileID int64, epoch int32, stored *vault.CRDTUpdate) outbound {
	frame := outbound{
		Type:      FrameUpdate,
		FileID:    fileID,
		Epoch:     epoch,
		Seq:       stored.Seq,
		Payload:   stored.Payload.Ciphertext,
		Nonce:     stored.Payload.Nonce,
		Signature: stored.Signature,
	}

	if stored.AuthorID != nil {
		frame.UserID = *stored.AuthorID
	}

	return frame
}

func acknowledged(fileID int64, epoch int32, seq int64) outbound {
	return outbound{Type: FrameAck, FileID: fileID, Epoch: epoch, Seq: seq}
}

// awareness carries somebody's carets, sealed. The user id is the server's own, not the
// one inside the blob: a client cannot claim to be somebody else by writing their name in
// a payload nobody but the readers can open.
func awareness(fileID, userID int64, payload, nonce []byte) outbound {
	return outbound{
		Type:    FrameAwareness,
		FileID:  fileID,
		UserID:  userID,
		Payload: payload,
		Nonce:   nonce,
	}
}

func presence(fileID int64, peers []peer, committing bool) outbound {
	return outbound{Type: FramePresence, FileID: fileID, Peers: peers, Committing: committing}
}

// reseed tells a room its document has been replaced — by a body written around it, or by
// a re-key — and that what they hold cannot be merged into what is there now.
func reseed(fileID int64, epoch int32) outbound {
	return outbound{Type: FrameReseed, FileID: fileID, Epoch: epoch}
}

func failure(code, message string) outbound {
	return outbound{Type: FrameError, Code: code, Message: message}
}

func failureFor(fileID int64, code, message string) outbound {
	return outbound{Type: FrameError, FileID: fileID, Code: code, Message: message}
}
