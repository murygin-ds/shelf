package vault

import (
	"context"
	"encoding/json"
	"time"
)

// AuditAction is what happened. The vocabulary is deliberately small: every entry answers
// "who changed whose access to what", which is the only history the server is able to keep.
type AuditAction string

const (
	AuditMemberJoined AuditAction = "member.joined"
	AuditMemberRole   AuditAction = "member.role_changed"
	AuditMemberRemove AuditAction = "member.removed"
	AuditGrantSet     AuditAction = "grant.set"
	AuditGrantCleared AuditAction = "grant.cleared"
	AuditInviteMade   AuditAction = "invite.created"
	AuditInviteGone   AuditAction = "invite.revoked"
	AuditKeyProtected AuditAction = "key.protected"
	AuditKeyRotated   AuditAction = "key.rotated"
	AuditShareOpened  AuditAction = "share.created"
	AuditShareRevoked AuditAction = "share.revoked"
	AuditGroupCreated AuditAction = "group.created"
	AuditGroupMembers AuditAction = "group.members_changed"
	AuditGroupGone    AuditAction = "group.deleted"
)

// AuditEvent is one entry of the log.
//
// It carries ids and never names: the folder a grant was set on is a number here, and the
// reader draws the label from their own decrypted tree. A reader who cannot see the node
// sees the event with nothing to render it as, which is the honest outcome.
type AuditEvent struct {
	ID          int64
	ActorID     *int64
	ActorLogin  string
	ActorName   string
	Action      AuditAction
	TargetType  string
	TargetID    *int64
	SubjectType string
	SubjectID   *int64
	Detail      json.RawMessage
	CreatedAt   time.Time
}

// DefaultAuditLimit is one screen of history.
const DefaultAuditLimit = 50

// MaxAuditLimit bounds one page.
const MaxAuditLimit = 200

// AuditRepository reads the log. Writing is not part of it: an audit entry is only
// trustworthy if it lands in the same transaction as the change it describes, so every
// write happens inside the operation it belongs to.
type AuditRepository interface {
	AuditEvents(ctx context.Context, vaultID, before int64, limit int) ([]AuditEvent, error)
}

// Audit reads the log. Only somebody who can manage the vault may: the log is a complete
// record of who works with whom, and handing it to every reader would give away more than
// the tree itself does.
func (s *Service) Audit(ctx context.Context, userID, vaultID, before int64, limit int) ([]AuditEvent, error) {
	member, err := s.member(ctx, vaultID, userID)
	if err != nil {
		return nil, err
	}

	if !member.Role.Manages() {
		return nil, ErrForbidden
	}

	switch {
	case limit <= 0:
		limit = DefaultAuditLimit
	case limit > MaxAuditLimit:
		limit = MaxAuditLimit
	}

	events, err := s.audit.AuditEvents(ctx, vaultID, before, limit)
	if err != nil {
		return nil, translate(err, "read audit")
	}

	return events, nil
}
