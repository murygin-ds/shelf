package realtime

import (
	"sort"
	"sync"

	"shelf/internal/vault"
)

// room is everyone open on one note.
//
// Seats are kept in join order, which is the whole of the committer rule: the longest
// standing connection that may write is the one that writes the body back. The server
// decides it because it already knows the room; an election among clients would only add a
// way for two of them to both believe they won.
type room struct {
	fileID int64

	mu    sync.Mutex
	seats []*seat
}

type seat struct {
	conn       *conn
	permission vault.Permission
	login      string
	name       string
}

func (r *room) join(c *conn, permission vault.Permission, login, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, existing := range r.seats {
		if existing.conn == c {
			existing.permission = permission
			return
		}
	}

	r.seats = append(r.seats, &seat{conn: c, permission: permission, login: login, name: name})
}

// leave removes a connection and reports whether the room is now empty.
func (r *room) leave(c *conn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i, existing := range r.seats {
		if existing.conn == c {
			r.seats = append(r.seats[:i], r.seats[i+1:]...)
			break
		}
	}

	return len(r.seats) == 0
}

// audience is everyone in the room except one connection — usually the one that spoke.
func (r *room) audience(except *conn) []*conn {
	r.mu.Lock()
	defer r.mu.Unlock()

	others := make([]*conn, 0, len(r.seats))

	for _, s := range r.seats {
		if s.conn != except {
			others = append(others, s.conn)
		}
	}

	return others
}

func (r *room) everyone() []*conn {
	return r.audience(nil)
}

// committerLocked is the longest standing connection that may write. The clients learn it
// from the flag on the presence frame rather than by asking.
func (r *room) committerLocked() *conn {
	for _, s := range r.seats {
		if s.permission.AtLeast(vault.PermEdit) {
			return s.conn
		}
	}

	return nil
}

// peersLocked is the room as the clients see it. One person in two tabs appears once: the
// list answers "who is here", and a second tab is not a second person.
func (r *room) peersLocked() []peer {
	committer := r.committerLocked()

	byUser := make(map[int64]peer, len(r.seats))
	order := make([]int64, 0, len(r.seats))

	for _, s := range r.seats {
		existing, seen := byUser[s.conn.userID]
		if !seen {
			order = append(order, s.conn.userID)
		}

		entry := peer{
			UserID:      s.conn.userID,
			Login:       s.login,
			DisplayName: s.name,
			Permission:  string(s.permission),
			Committer:   existing.Committer || s.conn == committer,
		}

		// Two tabs with different permissions cannot happen today, but if they ever did the
		// list should say what the person can do at their best, not at their newest.
		if seen && vault.Permission(existing.Permission).AtLeast(s.permission) {
			entry.Permission = existing.Permission
		}

		byUser[s.conn.userID] = entry
	}

	list := make([]peer, 0, len(order))
	for _, userID := range order {
		list = append(list, byUser[userID])
	}

	sort.SliceStable(list, func(i, j int) bool { return list[i].Committer && !list[j].Committer })

	return list
}

// room returns the room for a note, creating it on first use.
func (h *Hub) room(fileID int64) *room {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.closed {
		return nil
	}

	existing, ok := h.rooms[fileID]
	if !ok {
		existing = &room{fileID: fileID}
		h.rooms[fileID] = existing
	}

	return existing
}

// lookupRoom finds a room without creating one.
func (h *Hub) lookupRoom(fileID int64) *room {
	h.mu.Lock()
	defer h.mu.Unlock()

	return h.rooms[fileID]
}

// dropRoom forgets an empty room, so a vault edited all day does not leave a map entry per
// note behind it.
func (h *Hub) dropRoom(fileID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if existing, ok := h.rooms[fileID]; ok && existing.empty() {
		delete(h.rooms, fileID)
	}
}

func (r *room) empty() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.seats) == 0
}

// announcePresence tells the room who is in it. It is sent on every change of the roster,
// because the committer moves with it.
//
// The frame is built per connection, not per room, because "who is here" and "are you the
// one writing the body back" are different questions. The first is about people and lists
// somebody once however many tabs they have open; the second is about this socket. One
// person with two tabs would otherwise see the committer flag on themselves in both, and
// both would write — which is two writers racing the same If-Match, and one of them
// getting a conflict banner for its trouble.
func (r *room) announcePresence() {
	list, committer := r.roster()

	for _, c := range r.audience(nil) {
		c.send(presence(r.fileID, list, c == committer))
	}
}

// roster is the room as the clients see it, together with the connection that commits.
func (r *room) roster() ([]peer, *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.peersLocked(), r.committerLocked()
}
